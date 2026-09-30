"""本地加密备份：口令派生密钥 + Fernet 对称加密（cryptography）。

备份包 JSON 结构（加密态）：
    {"version": "xiaoman-backup-v1", "encrypted": true, "kdf": "pbkdf2-sha256",
     "iters": 200000, "salt": "<b64>", "payload": "<b64 Fernet token>"}

口令只用于派生密钥，绝不落盘、不随备份包保存。忘记口令即无法恢复——
这是财务数据的刻意设计（宁可打不开，不能被人打开）。
"""

from __future__ import annotations

import base64
import json
import secrets
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

_ITERS = 200_000
_VERSION = "xiaoman-backup-v1"


def _derive(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=_ITERS)
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt_export(data: dict[str, Any], passphrase: str) -> dict[str, Any]:
    """全量导出数据 → 加密备份包（不包含口令本身）。"""
    salt = secrets.token_bytes(16)
    f = Fernet(base64.urlsafe_b64encode(_derive(passphrase, salt)))
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    token = f.encrypt(raw)
    return {
        "version": _VERSION,
        "encrypted": True,
        "kdf": "pbkdf2-sha256",
        "iters": _ITERS,
        "salt": base64.b64encode(salt).decode(),
        "payload": token.decode(),
    }


def decrypt_export(payload: dict[str, Any], passphrase: str) -> dict[str, Any]:
    """加密备份包 + 口令 → 原始导出 JSON。口令错误抛 ValueError。"""
    if not payload.get("encrypted"):
        return payload
    try:
        salt = base64.b64decode(str(payload.get("salt") or ""))
    except Exception as exc:  # noqa: BLE001
        raise ValueError("备份文件已损坏（salt 无法解析）") from exc
    f = Fernet(base64.urlsafe_b64encode(_derive(passphrase, salt)))
    try:
        raw = f.decrypt(str(payload.get("payload") or "").encode())
    except InvalidToken as exc:
        raise ValueError("口令不正确或备份文件已损坏") from exc
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("备份内容格式不正确")
    return data
