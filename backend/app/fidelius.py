"""Fidelius (ABDM health-data encryption) — HIU-side key material and decryption.

Fidelius is the *protocol* ABDM mandates for FHIR data in transit; it is not
standard JOSE/CO-JWE. The scheme (NHA's "Implementation Guidelines for
Encrypting and Decrypting FHIR Data in ABDM"):

    * curve25519 **in short-Weierstrass form** — the BouncyCastle curve, NOT
      Montgomery X25519. This is the single biggest interoperability trap:
      ``cryptography``'s X25519, PyNaCl and Node's ``crypto.diffieHellman`` all
      speak Montgomery form and produce different shared secrets, so a
      standards-correct X25519 implementation will fail against a real HIP with
      ``ABDM-9999: Could not read encrypted content``.
    * one ephemeral ECDH keypair per exchange (perfect forward secrecy)
    * a 32-byte nonce each side; XOR them, first 20 bytes = HKDF salt,
      last 12 bytes = AES-GCM IV
    * shared secret = the x-coordinate of ``d * Q``, 32 bytes big-endian
    * AES key = HKDF-SHA256(ikm=shared_secret, salt=derived salt, info=empty)
    * payload = base64(ciphertext || 16-byte GCM tag)

Because the curve is a BouncyCastle-specific Weierstrass form, no mainstream
Python crypto library exposes it, so the point arithmetic below is written out
in pure Python. It is ~250 scalar multiplications' worth of modular arithmetic
per exchange — milliseconds, and only on a data pull, never in the triage loop.

This module is deliberately split from ``abdm.py``: it is pure crypto with no
network or state, and it is verified against the published fidelius-cli test
vectors in ``tests/test_fidelius.py``. If those vectors pass, an exchange with a
real HIP will decrypt; if they fail, nothing downstream can be trusted.

Honest scope (see ABDM_INTEGRATION.md):
    * This implements the *documented* Fidelius scheme (the version whose test
      vectors ship with fidelius-cli / pyfidelius). NHA has since published
      Fidelius 2.x; a 2.x HIP would need the versioned variant added here. The
      protocol version is a HIP/CM-level integration question, not something
      this code can guess.
    * Decryption is the HIU's half. Rotation of HIU key material is per-exchange
      and in-memory (see abdm.py limitation notes).
"""
from __future__ import annotations

import base64
import os
import secrets
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# --------------------------------------------------------------------------- #
# BouncyCastle Curve25519 (short Weierstrass form), y^2 = x^3 + ax + b mod p.
#
# WARNING: the values in BouncyCastle's CustomNamedCurves.java *comments* are
# wrong (a widely copy-pasted bug). The authoritative values are the ones the
# implementation class actually uses. The generator below satisfies the curve
# equation with these a/b — which is how we verified them, and the key-derivation
# test vector is what keeps them honest.
# --------------------------------------------------------------------------- #
_P = int("7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed", 16)
_A = int("2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA984914A144", 16)
_B = int("7B425ED097B425ED097B425ED097B425ED097B425ED097B4260B5E9C7710C864", 16)
_N = int("1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed", 16)
_GX = int("2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245a", 16)
_GY = int("20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d9", 16)

# DER prefix BouncyCastle emits for an uncompressed EC public key on this curve.
# ABDM's ``keyMaterial.keyValue`` is the X.509 DER form, not the bare point —
# sending the raw ``04||X||Y`` point is rejected on a real CM/HIP.
_X509_PREFIX_B64 = (
    "MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7"
    "TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyG"
    "QEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAi"
    "AQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQ="
)
_X509_PREFIX = base64.b64decode(_X509_PREFIX_B64)

NONCE_LENGTH = 32
TAG_LENGTH = 16


class FideliusError(Exception):
    """Raised when key material or ciphertext cannot be processed."""


Point = "tuple[int, int] | None"  # None is the point at infinity


# --------------------------------------------------------------------------- #
# Point arithmetic (affine, prime field). Small and auditable on purpose.
# --------------------------------------------------------------------------- #
def _inv(x: int) -> int:
    return pow(x, -1, _P)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None  # P + (-P) = infinity
    if p1 == p2:
        lam = (3 * x1 * x1 + _A) * _inv(2 * y1) % _P
    else:
        lam = (y2 - y1) * _inv(x2 - x1) % _P
    x3 = (lam * lam - x1 - x2) % _P
    return x3, (lam * (x1 - x3) - y1) % _P


def _mul(k: int, point):
    """Scalar multiplication, double-and-add (not constant-time)."""
    result = None
    addend = point
    while k:
        if k & 1:
            result = _add(result, addend)
        addend = _add(addend, addend)
        k >>= 1
    return result


GENERATOR = (_GX, _GY)


def _on_curve(point) -> bool:
    x, y = point
    return (y * y - (x * x * x + _A * x + _B)) % _P == 0


# --------------------------------------------------------------------------- #
# Encoding. Big-endian, fixed 32-byte coordinates (network byte order), which is
# what the spec asks for: uncompressed keys as ``04 || X || Y``.
# --------------------------------------------------------------------------- #
def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(text: str, what: str) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except Exception as exc:  # noqa: BLE001 - any malformed base64 is one error
        raise FideliusError(f"{what} is not valid base64") from exc


def encode_private_key(private_key: int) -> str:
    return _b64(private_key.to_bytes(32, "big"))


def decode_private_key(encoded: str) -> int:
    raw = _unb64(encoded, "private key")
    if len(raw) != 32:
        raise FideliusError(f"private key must be 32 bytes, got {len(raw)}")
    value = int.from_bytes(raw, "big")
    if not 0 < value < _N:
        raise FideliusError("private key is outside the curve group order")
    return value


def encode_public_key(point) -> str:
    """``04 || X || Y``, base64 — the bare uncompressed point."""
    if point is None:
        raise FideliusError("cannot encode the point at infinity")
    x, y = point
    return _b64(b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big"))


def encode_x509_public_key(point) -> str:
    """`keyValue` as ABDM sends it: X.509 DER wrapping the uncompressed point."""
    if point is None:
        raise FideliusError("cannot encode the point at infinity")
    x, y = point
    return _b64(_X509_PREFIX + x.to_bytes(32, "big") + y.to_bytes(32, "big"))


def decode_public_key(encoded: str):
    """Accept either form: bare ``04||X||Y`` or X.509 DER (last 64 bytes).

    Both are seen in the wild — a HIP that follows the spec sends the DER form,
    a HIP that read the "uncompressed point" paragraph sends the raw point. We
    accept both rather than fail an exchange over an encoding nicety.
    """
    raw = _unb64(encoded, "public key")
    if len(raw) == 65:
        if raw[0] != 0x04:
            raise FideliusError("uncompressed public key must start with 0x04")
        x, y = int.from_bytes(raw[1:33], "big"), int.from_bytes(raw[33:], "big")
    elif len(raw) >= 64:
        x, y = int.from_bytes(raw[-64:-32], "big"), int.from_bytes(raw[-32:], "big")
    else:
        raise FideliusError(f"public key is {len(raw)} bytes — too short")
    point = (x, y)
    if not _on_curve(point):
        raise FideliusError("public key is not a point on curve25519")
    return point


def generate_nonce() -> str:
    return _b64(os.urandom(NONCE_LENGTH))


# --------------------------------------------------------------------------- #
# Key material
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class KeyMaterial:
    """One exchange's ephemeral HIU key material.

    The HIU generates this BEFORE requesting data and keeps the private half;
    only the public half travels to the CM/HIP. The private key exists so the
    eventual ``on-request`` payload can be decrypted, and is discarded after.
    """

    private_key: str
    public_key: str
    x509_public_key: str
    nonce: str

    @classmethod
    def generate(cls, private_key: int | None = None) -> "KeyMaterial":
        if private_key is None:
            private_key = secrets.randbelow(_N - 1) + 1
        point = _mul(private_key, GENERATOR)
        if point is None:
            raise FideliusError("key generation produced the point at infinity")
        return cls(
            private_key=encode_private_key(private_key),
            public_key=encode_public_key(point),
            x509_public_key=encode_x509_public_key(point),
            nonce=generate_nonce(),
        )

    def request_block(self) -> dict:
        """The ``keyMaterial`` object as it is embedded in the HI request."""
        return {
            "cryptoAlg": "ECDH",
            "curve": "Curve25519",
            "params": "Curve25519",
            "DHPublicKey": {"expiry": None, "parameters": "Curve25519", "keyValue": self.x509_public_key},
            "nonce": self.nonce,
        }


def derive_session_keys(own_private_key: str, own_nonce: str, peer_public_key: str, peer_nonce: str):
    """Recompute the ECDH shared secret and the AES-GCM (key, iv).

    Symmetric by construction — HIP and HIU run the identical steps and must
    arrive at the same key, which is exactly what the XOR (commutative) and the
    shared x-coordinate give us.
    """
    private = decode_private_key(own_private_key)
    peer_point = decode_public_key(peer_public_key)
    shared_point = _mul(private, peer_point)
    if shared_point is None:
        raise FideliusError("ECDH produced the point at infinity — refusing to derive a key")
    shared_secret = shared_point[0].to_bytes(32, "big")

    own = _unb64(own_nonce, "nonce")
    peer = _unb64(peer_nonce, "nonce")
    if len(own) != NONCE_LENGTH or len(peer) != NONCE_LENGTH:
        raise FideliusError("both nonces must be 32 bytes")
    xor = bytes(a ^ b for a, b in zip(own, peer))
    salt, iv = xor[:20], xor[20:]

    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=b"").derive(shared_secret)
    return key, iv


# --------------------------------------------------------------------------- #
# Payload encryption / decryption
#
# The primitive is TEXT-in / TEXT-out: the reference implementation encrypts the
# utf-8 bytes of the string it is handed, with no extra encoding step. ABDM's
# convention is that the HIP first base64-encodes the FHIR bundle JSON and hands
# that base64 STRING in — so the "plaintext" is already base64 by the time AES
# sees it. `encrypt_fhir_bundle` owns that second step, and its absence is one of
# the classic ABDM mistakes ("sending plain base64 FHIR instead of encrypted
# content" / double-encoding the payload).
# --------------------------------------------------------------------------- #
def encrypt_text(plaintext: str, own_private_key: str, own_nonce: str,
                 peer_public_key: str, peer_nonce: str) -> str:
    """Encrypt text -> base64(ciphertext || tag). Used by the mock HIP and tests."""
    key, iv = derive_session_keys(own_private_key, own_nonce, peer_public_key, peer_nonce)
    return _b64(AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None))


def decrypt_text(ciphertext_b64: str, own_private_key: str, own_nonce: str,
                 peer_public_key: str, peer_nonce: str) -> str:
    """Decrypt a Fidelius payload back to text.

    The GCM tag IS verified (the reference Java/Python examples decrypt without a
    tag, which would let a tampered record through as garbage). A tampered or
    mis-keyed payload raises here rather than returning bytes we would hand on to
    the mapper and re-score.
    """
    key, iv = derive_session_keys(own_private_key, own_nonce, peer_public_key, peer_nonce)
    blob = _unb64(ciphertext_b64, "encrypted data")
    if len(blob) <= TAG_LENGTH:
        raise FideliusError("encrypted payload is too short to contain a GCM tag")
    try:
        inner = AESGCM(key).decrypt(iv, blob, None)
    except Exception as exc:  # noqa: BLE001 - InvalidTag and friends, one meaning
        raise FideliusError(
            "payload failed AES-GCM authentication — wrong key material, wrong nonces, "
            "or the content was tampered with"
        ) from exc
    try:
        return inner.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FideliusError("decrypted content was not utf-8 text (not an ABDM payload)") from exc


def encrypt_fhir_bundle(bundle: dict | str, own_private_key: str, own_nonce: str,
                        peer_public_key: str, peer_nonce: str) -> str:
    """HIP side: FHIR bundle -> base64(JSON) -> Fidelius ciphertext."""
    import json

    text = bundle if isinstance(bundle, str) else json.dumps(bundle, separators=(",", ":"))
    return encrypt_text(_b64(text.encode("utf-8")), own_private_key, own_nonce,
                        peer_public_key, peer_nonce)


def decrypt_fhir_bundle(ciphertext_b64: str, own_private_key: str, own_nonce: str,
                        peer_public_key: str, peer_nonce: str) -> dict:
    """HIU side: Fidelius ciphertext -> the FHIR bundle the HIP sent."""
    import json

    inner = decrypt_text(ciphertext_b64, own_private_key, own_nonce,
                         peer_public_key, peer_nonce)
    try:
        raw = base64.b64decode(inner, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise FideliusError("decrypted content was not valid base64 (not an ABDM payload)") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise FideliusError("decrypted payload was base64 but not a JSON FHIR bundle") from exc
