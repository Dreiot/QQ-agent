"""Configure this Windows user's own WeChat database, without key discovery or sends.

The supplied passphrase is verified locally then encrypted with current-user DPAPI.
No account data, plaintext key, DLL, or runtime is committed to the repository.
"""
import argparse
import base64
import ctypes
from ctypes import wintypes
import getpass
import json
import os
import pathlib
import secrets
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src/wechat-db/vendor'))


def protect(value):
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = value.encode('utf-8')
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, result = Blob(len(raw), buf), Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt.CryptProtectData.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                                     ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    if not crypt.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise RuntimeError('Current-user DPAPI failed')
    try:
        return 'userdpapi:' + base64.b64encode(ctypes.string_at(result.data, result.size)).decode('ascii')
    finally:
        kernel.LocalFree(result.data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-path', required=True, help='Your account directory containing db_storage')
    parser.add_argument('--data-dir', default=os.environ.get('QQ_AGENT_DATA_DIR', str(ROOT / 'data')))
    args = parser.parse_args()
    if sys.platform != 'win32':
        raise RuntimeError('Windows only')
    account = pathlib.Path(args.account_path).resolve(strict=True)
    database = account / 'db_storage/message/message_0.db'
    if not database.is_file():
        raise RuntimeError('message_0.db not found below the chosen account directory')
    target = pathlib.Path(args.data_dir).resolve() / 'desktop-wechat'
    target.mkdir(parents=True, exist_ok=True)
    credential_file = target / 'database.private.json'
    if credential_file.exists():
        raise RuntimeError('Existing credentials were preserved; choose the intended data directory')
    from nt_decrypt import verify_passphrase_native
    passphrase = getpass.getpass('Existing database passphrase (hidden): ')
    if verify_passphrase_native(passphrase, str(database)) is not True:
        raise RuntimeError('Database passphrase verification failed; nothing saved')
    credentials = {'accountPath': str(account), 'protectedKey': protect(passphrase)}
    with credential_file.open('x', encoding='utf-8') as file:
        json.dump(credentials, file, ensure_ascii=False, indent=2)
    sender_file = target / 'native-send.private.json'
    if not sender_file.exists():
        with sender_file.open('x', encoding='utf-8') as file:
            json.dump({'baseUrl': 'http://127.0.0.1:30005', 'token': secrets.token_hex(32),
                       'expectedVersion': '4.1.15.13', 'accepted': False,
                       'nativeImagesAccepted': False, 'nativeMentionsAccepted': False}, file, indent=2)
    print('Local configuration created. Channel and acceptance flags remain disabled. No messages sent.')


if __name__ == '__main__':
    main()
