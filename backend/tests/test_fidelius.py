"""Fidelius crypto verified against the PUBLISHED reference test vectors.

These vectors come from the Java reference implementation (mgrmtech/fidelius-cli)
and are the ones dimagi/pyfidelius tests against. They are the only meaningful
proof that our pure-Python curve25519 speaks the same dialect as a real HIP:
the curve is BouncyCastle's short-Weierstrass form, so a "correct" X25519
implementation would pass none of these.

If a future refactor breaks key derivation, encryption or the X.509 wrapping,
these tests fail loudly instead of the failure surfacing as ABDM-9999 in a demo.
"""
from __future__ import annotations

import base64

import pytest

from app import fidelius

# --- vectors from fidelius-cli README / pyfidelius tests.py ----------------- #
TEST_PRIVATE_KEY = "DMxHPri8d7IT23KgLk281zZenMfVHSdeamq0RhwlIBk="
TEST_PUBLIC_KEY = "BAheD5rUqTy4V5xR4/6HWmYpopu5CO+KO8BECS0udNqUTSNo91TIqIIy1A4Vh+F94c+n9vAcwXU2bGcfsI5f69Y="
TEST_X509_PUBLIC_KEY = (
    "MIIBMTCB6gYHKoZIzj0CATCB3gIBATArBgcqhkjOPQEBAiB/////////////////////////////////////////7"
    "TBEBCAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqYSRShRAQge0Je0Je0Je0Je0Je0Je0Je0Je0Je0Je0JgtenHcQyG"
    "QEQQQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0kWiCuGaG4oIa04B7dLHdI0UySPU1+bXxhsinpxaJ+ztPZAi"
    "AQAAAAAAAAAAAAAAAAAAAAFN753qL3nNZYEmMaXPXT7QIBCANCAAQIXg+a1Kk8uFecUeP+h1pmKaKbuQjvijvARAktLnTalE"
    "0jaPdUyKiCMtQOFYfhfeHPp/bwHMF1NmxnH7COX+vW"
)
SENDER_NONCE = "lmXgblZwotx+DfBgKJF0lZXtAXgBEYr5khh79Zytr2Y="
REQUESTER_NONCE = "6uj1RdDUbcpI3lVMZvijkMC8Te20O4Bcyz0SyivX8Eg="
SENDER_PRIVATE_KEY = "AYhVZpbVeX4KS5Qm/W0+9Ye2q3rnVVGmqRICmseWni4="
SENDER_PUBLIC_KEY = "BABVt+mpRLMXiQpIfEq6bj8hlXsdtXIxLsspmMgLNI1SR5mHgDVbjHO2A+U4QlMddGzqyEidzm1AkhtSxSO2Ahg="
PLAINTEXT = "Wormtail should never have been Potter cottage's secret keeper."
EXPECTED_CIPHERTEXT = "pzMvVZNNVtJzqPkkxcCbBUWgDEBy/mBXIeT2dJWI16ZAQnnXUb9lI+S4k8XK6mgZSKKSRIHkcNvJpllnBg548wUgavBa0vCRRwdL6kY6Yw=="
EXPECTED_SHARED_SECRET_X = "HZbc9a4h9kMAReILN5VtvbSYHWQpfIcrZ9pWHlQZUHs="
EXPECTED_PRIVATE_KEY_INT = (
    5788682699176295281730350068232349311395990232835367296300538348913375387673
)


def test_curve_params_are_actually_a_curve():
    """The generator must satisfy y^2 = x^3 + ax + b — the check that exposes the
    wrong a/b values copy-pasted from BouncyCastle's comments."""
    assert fidelius._on_curve(fidelius.GENERATOR)


def test_public_key_derivation_matches_bouncycastle():
    """BC-private-key in -> BC public key out. Proves our a, b, p and g are right."""
    material = fidelius.KeyMaterial.generate(private_key=EXPECTED_PRIVATE_KEY_INT)
    assert material.private_key == TEST_PRIVATE_KEY
    assert material.public_key == TEST_PUBLIC_KEY
    assert material.x509_public_key == TEST_X509_PUBLIC_KEY


def test_private_key_round_trip():
    assert fidelius.decode_private_key(TEST_PRIVATE_KEY) == EXPECTED_PRIVATE_KEY_INT
    assert fidelius.encode_private_key(EXPECTED_PRIVATE_KEY_INT) == TEST_PRIVATE_KEY


def test_public_key_decodes_from_both_encodings():
    bare = fidelius.decode_public_key(TEST_PUBLIC_KEY)
    x509 = fidelius.decode_public_key(TEST_X509_PUBLIC_KEY)
    assert bare == x509
    assert fidelius.encode_public_key(bare) == TEST_PUBLIC_KEY
    assert fidelius.encode_x509_public_key(bare) == TEST_X509_PUBLIC_KEY


def test_shared_secret_is_symmetric():
    """HIP and HIU must derive the SAME secret from opposite halves."""
    hip = fidelius.derive_session_keys(SENDER_PRIVATE_KEY, SENDER_NONCE, TEST_PUBLIC_KEY, REQUESTER_NONCE)
    hiu = fidelius.derive_session_keys(TEST_PRIVATE_KEY, REQUESTER_NONCE, SENDER_PUBLIC_KEY, SENDER_NONCE)
    assert hip == hiu

    # ...and the x-coordinate itself matches the reference value.
    private = fidelius.decode_private_key(TEST_PRIVATE_KEY)
    point = fidelius._mul(private, fidelius.decode_public_key(SENDER_PUBLIC_KEY))
    encoded = base64.b64encode(point[0].to_bytes(32, "big")).decode()
    assert encoded == EXPECTED_SHARED_SECRET_X


def test_encryption_matches_reference_ciphertext():
    """HIP-side encryption byte-for-byte against the Java reference.

    Nonces and keys are fixed, so AES-GCM is deterministic here — any deviation
    in salt/IV derivation or HKDF shows up as a different ciphertext.
    """
    ciphertext = fidelius.encrypt_text(
        PLAINTEXT,
        own_private_key=SENDER_PRIVATE_KEY,
        own_nonce=SENDER_NONCE,
        peer_public_key=TEST_PUBLIC_KEY,
        peer_nonce=REQUESTER_NONCE,
    )
    assert ciphertext == EXPECTED_CIPHERTEXT


def test_decryption_round_trips_the_reference_payload():
    """The HIU's half: decrypt what the reference HIP produced."""
    recovered = fidelius.decrypt_text(
        EXPECTED_CIPHERTEXT,
        own_private_key=TEST_PRIVATE_KEY,
        own_nonce=REQUESTER_NONCE,
        peer_public_key=SENDER_PUBLIC_KEY,
        peer_nonce=SENDER_NONCE,
    )
    assert recovered == PLAINTEXT


def test_x509_public_key_works_as_cipher_input():
    """A HIP that sends the DER form must interoperate identically."""
    ciphertext = fidelius.encrypt_text(
        PLAINTEXT,
        own_private_key=SENDER_PRIVATE_KEY,
        own_nonce=SENDER_NONCE,
        peer_public_key=TEST_X509_PUBLIC_KEY,
        peer_nonce=REQUESTER_NONCE,
    )
    assert ciphertext == EXPECTED_CIPHERTEXT


def test_round_trips_a_real_fhir_bundle():
    """End-to-end shape the app actually uses: FHIR bundle in, bundle out."""
    bundle = {
        "resourceType": "Bundle",
        "type": "collection",
        "entry": [{"resource": {"resourceType": "Patient", "id": "P1"}}],
    }
    hiu = fidelius.KeyMaterial.generate()
    hip = fidelius.KeyMaterial.generate()

    ciphertext = fidelius.encrypt_fhir_bundle(
        bundle,
        own_private_key=hip.private_key, own_nonce=hip.nonce,
        peer_public_key=hiu.public_key, peer_nonce=hiu.nonce,
    )
    assert ciphertext != EXPECTED_CIPHERTEXT  # exercised the real path, not a fixture
    recovered = fidelius.decrypt_fhir_bundle(
        ciphertext,
        own_private_key=hiu.private_key, own_nonce=hiu.nonce,
        peer_public_key=hip.public_key, peer_nonce=hip.nonce,
    )
    assert recovered == bundle


def test_tampered_ciphertext_is_rejected():
    """GCM tag must be verified — a flipped byte is not silently accepted."""
    hiu = fidelius.KeyMaterial.generate()
    hip = fidelius.KeyMaterial.generate()
    ciphertext = fidelius.encrypt_text(
        "patient data", own_private_key=hip.private_key, own_nonce=hip.nonce,
        peer_public_key=hiu.public_key, peer_nonce=hiu.nonce,
    )
    blob = bytearray(base64.b64decode(ciphertext))
    blob[0] ^= 0x01
    with pytest.raises(fidelius.FideliusError, match="authentication"):
        fidelius.decrypt_text(
            base64.b64encode(bytes(blob)).decode(),
            own_private_key=hiu.private_key, own_nonce=hiu.nonce,
            peer_public_key=hip.public_key, peer_nonce=hip.nonce,
        )


def test_wrong_key_material_is_rejected():
    """A mismatched nonce/partner must fail, not return plausible garbage."""
    hiu = fidelius.KeyMaterial.generate()
    hip = fidelius.KeyMaterial.generate()
    other = fidelius.KeyMaterial.generate()
    ciphertext = fidelius.encrypt_text(
        "patient data", own_private_key=hip.private_key, own_nonce=hip.nonce,
        peer_public_key=hiu.public_key, peer_nonce=hiu.nonce,
    )
    with pytest.raises(fidelius.FideliusError):
        fidelius.decrypt_text(
            ciphertext,
            own_private_key=other.private_key, own_nonce=hiu.nonce,
            peer_public_key=hip.public_key, peer_nonce=hip.nonce,
        )


def test_malformed_key_material_is_rejected_clearly():
    with pytest.raises(fidelius.FideliusError, match="base64"):
        fidelius.decode_private_key("not base64!!")
    with pytest.raises(fidelius.FideliusError, match="32 bytes"):
        fidelius.decode_private_key(base64.b64encode(b"short").decode())
    with pytest.raises(fidelius.FideliusError, match="not a point on curve25519"):
        fidelius.decode_public_key(base64.b64encode(bytes([0x04]) + b"\xff" * 64).decode())
    with pytest.raises(fidelius.FideliusError, match="too short"):
        fidelius.decode_public_key(base64.b64encode(b"\x04" * 10).decode())


def test_request_block_shape_matches_abdm_contract():
    """keyMaterial as the CM expects to receive it inside the HI request."""
    material = fidelius.KeyMaterial.generate()
    block = material.request_block()
    assert block["cryptoAlg"] == "ECDH"
    assert block["curve"] == "Curve25519"
    assert block["DHPublicKey"]["parameters"] == "Curve25519"
    # keyValue must be the X.509 DER form, not the raw uncompressed point.
    assert block["DHPublicKey"]["keyValue"] == material.x509_public_key
    assert len(base64.b64decode(material.nonce)) == fidelius.NONCE_LENGTH
