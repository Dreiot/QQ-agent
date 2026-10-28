"""Private NT database receiver. No UI actions, sends, or process injection.

Uses the reviewed MIT WeChatAgent/weflow reader and local media codecs in
vendor/. Incoming identity is the shard's Name2Id, never a displayed nickname.
"""
import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import pathlib
import queue
import re
import sys
import threading
import time
import uuid
import unicodedata

sys.path.insert(0, str(pathlib.Path(__file__).parent / 'vendor'))
import nt_decrypt as nt
import wechat_media as media
from wechat_sticker import resolve_sticker, sticker_image_xml, decode_wxgf
from wechat_image_normalize import normalize_image


def display_name_key(value):
    """Ignore a non-rendered prefix, not visible letters or emoji sequences."""
    text = str(value or '').strip()
    while text and unicodedata.category(text[0]) == 'Cf':
        text = text[1:].lstrip()
    return text


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def mention_ids(source):
    match = re.search(r'<atuserlist>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</atuserlist>', nt._decode_content(source), re.S)
    return [identity.strip() for identity in match.group(1).split(',') if identity.strip()] if match else []


def unconfirmed_outbound(row, own):
    return row['sender'] == own and int(row['local_type']) in (1, 3) and not row.get('server_id')


def unprotect(value):
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    raw = base64.b64decode(value.split(':', 1)[1], validate=True)
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, result = Blob(len(raw), buf), Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    if not value.startswith('userdpapi:') or not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise RuntimeError('DB_CREDENTIAL_UNAVAILABLE')
    try:
        return ctypes.string_at(result.data, result.size).decode('utf-8')
    finally:
        kernel.LocalFree(result.data)


def real_friend(identity, local_type, flag, deleted, verified, own=''):
    """Current NT contact schema: exclude cached group strangers and accounts."""
    return bool(identity and identity!=own and '@chatroom' not in identity
                and not identity.startswith('gh_') and identity not in ('filehelper','fmessage','weixin','medianote','newsapp')
                and int(local_type or 0) in (1,5) and int(flag or 0)&1
                and int(deleted or 0)==0 and int(verified or 0)==0)


class Reader:
    def __init__(self, credentials, media_root):
        cfg = json.loads(pathlib.Path(credentials).read_text(encoding='utf-8'))
        self.account = pathlib.Path(cfg['accountPath']).resolve()
        self.own = media.clean_account_wxid(self.account.name)
        self.passphrase = unprotect(cfg['protectedKey'])
        first = self.account / 'db_storage/message/message_0.db'
        if nt.verify_passphrase_native(self.passphrase, str(first)) is not True:
            raise RuntimeError('DB_KEY_NOT_VERIFIED')
        self.connections = {}
        self.media_root = pathlib.Path(media_root).resolve()
        self.media_root.mkdir(parents=True, exist_ok=True)
        self.refresh_contacts()
        self.shards = [(pathlib.Path(file).name, self.connect(file)) for file in nt.discover_message_shards(str(first)) if pathlib.Path(file).name != 'message_resource.db']
        self.targets, self.baselines, self.descriptors = {}, {}, {}
        self.media_key = None
        self.allow_sticker_cdn = False
        self.allow_sticker_alias = False
        self.received = 0
        self.skipped = 0
        self.names_refreshed_at = time.monotonic()

    def refresh_contacts(self):
        contact = self.connect(self.account / 'db_storage/contact/contact.db')
        rows = list(contact.execute("SELECT username,COALESCE(remark,''),COALESCE(nick_name,''),COALESCE(alias,'') FROM contact"))
        self.names = {identity: display_name_key(remark or nickname or alias or identity) for identity, remark, nickname, alias in rows}
        self.contact_aliases = {identity: {display_name_key(value) for value in (identity,remark,nickname,alias) if value}
                                for identity,remark,nickname,alias in rows}
        self.profiles = {identity: {'name': display_name_key(nickname or remark or identity), 'wechatId': alias or identity}
                         for identity, remark, nickname, alias in rows}
        self.friends = {identity for identity, local_type, flag, deleted, verified in contact.execute(
            'SELECT username,local_type,flag,delete_flag,verify_flag FROM contact')
            if real_friend(identity,local_type,flag,deleted,verified,self.own)}

    def connect(self, file):
        file = pathlib.Path(file).resolve()
        if not file.is_relative_to(self.account / 'db_storage') or not file.is_file():
            raise RuntimeError('DB_PATH_UNAVAILABLE')
        if str(file) not in self.connections:
            key, salt = nt.derive_database_key(str(file), '', '', self.passphrase)
            conn = nt.require_sqlcipher().connect(file.as_uri() + '?mode=ro', uri=True)
            conn.execute('PRAGMA key = "x\'%s%s\'"' % (key, salt))
            conn.execute('PRAGMA query_only=ON')
            conn.execute('SELECT name FROM sqlite_master LIMIT 1').fetchone()
            self.connections[str(file)] = conn
        return self.connections[str(file)]

    def configure(self, command):
        self.refresh_contacts()
        self.last_command = dict(command)
        self.allow_sticker_cdn = command.get('allowStickerCdn') is True
        self.allow_sticker_alias = command.get('allowStickerCdnAlias') is True
        targets, missing = {}, []
        for kind, field in (('group', 'groups'), ('private', 'privateChats')):
            for name in command.get(field, []):
                key = display_name_key(name)
                matches = [identity for identity, display in self.names.items()
                           if key in getattr(self,'contact_aliases',{}).get(identity,{display_name_key(display)})
                           and ('@chatroom' in identity) == (kind == 'group')]
                if len(matches) != 1:
                    missing.append({'kind': kind, 'name': name, 'reason': 'not-found' if not matches else 'ambiguous'})
                    continue
                targets[matches[0]] = {'kind': kind, 'name': name}
        if command.get('allowAllPrivateWhenEmpty') is True and not command.get('privateChats'):
            names = list(self.names.get(identity,identity) for identity in self.friends)
            for identity in self.friends:
                display = self.names.get(identity,identity)
                name = display if names.count(display)==1 else '%s [%s]' % (display,identity)
                targets[identity] = {'kind':'private','name':name,'friendVerified':True}
        self.targets = targets
        self.unresolved_targets = missing
        self.baselines = {key: value for key, value in self.baselines.items() if key in targets}
        return {'targetCount': len(targets), 'unresolvedTargets': missing, 'targets': [{'id': identity, **target} for identity, target in targets.items()]}

    def rows(self, talker, since=None):
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        result = []
        for shard, connection in self.shards:
            if not connection.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
                continue
            columns = nt.table_columns(connection.cursor(), table)
            fields = [field for field in nt.MESSAGE_COLUMNS if field in columns]
            if 'source' in columns and 'source' not in fields:
                fields.append('source')
            if not {'local_id', 'create_time', 'real_sender_id', 'local_type'}.issubset(columns):
                raise RuntimeError('DB_MESSAGE_SCHEMA_UNAVAILABLE')
            sql = 'SELECT %s FROM "%s"' % (','.join('"%s"' % field for field in fields), table)
            values = ()
            if since is not None:
                sql += ' WHERE create_time>=?'
                values = (since,)
            sql += ' ORDER BY create_time DESC, local_id DESC LIMIT 200'
            senders = dict(connection.execute('SELECT rowid,user_name FROM Name2Id'))
            for value in connection.execute(sql, values):
                row = dict(zip(fields, value))
                row['sender'] = senders.get(row.get('real_sender_id'), '')
                row['mid'] = 'wxdb-' + str(row.get('server_id')) if row.get('server_id') else 'wxdb-%s-%s-%s' % (shard, row['local_id'], row['create_time'])
                row['shard'] = shard
                result.append(row)
        return sorted(result, key=lambda row: (row['create_time'], row['local_id']))

    def resolve_media(self, talker, row):
        kind = int(row['local_type'])
        xml = nt._strip_group_speaker(nt._decode_content(row.get('message_content')), {row['sender']})
        if kind == 47 or kind == ((8 << 32) | 49):
            image = resolve_sticker(self.account, sticker_image_xml(kind, xml), normalize_image, allow_cdn=self.allow_sticker_cdn, allow_cdn_alias=self.allow_sticker_alias)
        else:
            ids = media.extract_media_md5s(xml)
            resource = self.account / 'db_storage/message/message_resource.db'
            if resource.is_file() and row.get('server_id'):
                db = self.connect(resource)
                for (packed,) in db.execute('SELECT packed_info FROM MessageResourceInfo WHERE message_svr_id=? AND message_local_id=? AND message_create_time=? LIMIT 4',
                                            (row['server_id'], row['local_id'], row['create_time'])):
                    ids += media.extract_blob_md5s(packed)
            if self.media_key is None:
                self.media_key = media.resolve_v2_media_key(str(self.account), self.own)
            if not self.media_key:
                raise RuntimeError('IMAGE_LOCAL_KEY_UNAVAILABLE')
            attach = self.account / 'msg/attach' / hashlib.md5(talker.encode()).hexdigest()
            image = None
            candidates = []
            for month in sorted(attach.iterdir(), reverse=True) if attach.is_dir() else []:
                for identity in list(dict.fromkeys(ids)):
                    for suffix in ('.dat', '_h.dat', '_t.dat'):
                        file = month / 'Img' / (identity + suffix)
                        if not file.is_file() or file.stat().st_size > media.MAX_EMBED_SIZE:
                            continue
                        candidates.append((suffix, file.stat().st_size, file))
            # Compare actual decoded dimensions across the message's own media
            # identifiers; an earlier thumbnail hash must not hide its full copy.
            candidates.sort(key=lambda c: (c[0] != '_t.dat', c[1]), reverse=True)
            best = (-1, -1)
            for suffix, _, file in candidates[:16]:
                decoded = media.decode_wechat_v2(str(file), *self.media_key)
                if not decoded:
                    continue
                try:
                    raw_image = decode_wxgf(decoded[0], photo=True) if decoded[1]=='image/x-wechat-wxgf' else decoded[0]
                    candidate = normalize_image(raw_image, max_dim=3072, max_bytes=4*1024*1024, preserve_png=True)
                except (RuntimeError, ValueError, OSError):
                    continue
                score = (candidate['originalWidth']*candidate['originalHeight'], suffix != '_t.dat')
                if score > best:
                    best, image = score, candidate
                    image['quality'] = 'thumbnail' if suffix == '_t.dat' else 'local-full'
            if image is None:
                raise RuntimeError('IMAGE_LOCAL_COPY_UNAVAILABLE')
        file = self.media_root / (uuid.uuid4().hex + ('.png' if image['mime']=='image/png' else '.jpg'))
        file.write_bytes(base64.b64decode(image['b64']))
        return {'kind': 'image', 'localFile': str(file), 'mime': image['mime'], 'width': image['width'], 'height': image['height'],
                'originalWidth': image.get('originalWidth', image['width']), 'originalHeight': image.get('originalHeight', image['height']), 'quality': image.get('quality','sticker-preview')}

    def poll(self):
        if time.monotonic()-getattr(self, 'names_refreshed_at', time.monotonic()) > 60:
            self.refresh_contacts()
            self.names_refreshed_at=time.monotonic()
            if (getattr(self,'unresolved_targets',[]) or getattr(self,'last_command',{}).get('allowAllPrivateWhenEmpty') is True) and getattr(self,'last_command',None):
                emit({'event':'db-configured',**self.configure(self.last_command)})
        for talker, target in self.targets.items():
            state = self.baselines.get(talker)
            rows = self.rows(talker, min(state['time'] - 2, int(time.time())-15) if state else None)
            if state is None:
                self.baselines[talker] = {'time': max((row['create_time'] for row in rows), default=int(time.time())),
                                          'seen': {row['mid'] for row in rows if not unconfirmed_outbound(row, self.own)}}
                members = {row['sender']: self.names.get(row['sender'], row['sender']) for row in rows if row['sender'] and row['sender'] != self.own}
                emit({'event': 'db-roster', 'chatName': target['name'], 'members': [
                    {'id': identity, **getattr(self, 'profiles', {}).get(identity, {'name': name, 'wechatId': identity})}
                    for identity, name in members.items()]})
                continue
            for row in rows:
                # Local sends may acquire their server ID on a later poll.
                # Do not consume them before that confirmation is available.
                if unconfirmed_outbound(row, self.own):
                    continue
                if row['mid'] in state['seen']:
                    continue
                state['seen'].add(row['mid'])
                state['time'] = max(state['time'], row['create_time'])
                if row['sender'] == self.own:
                    if int(row['local_type']) in (1,3) and row.get('server_id'):
                        emit({'event':'db-outbound','chatStableId':talker,'text':nt._strip_group_speaker(nt._decode_content(row.get('message_content')), {self.own}),
                              'messageType':'image' if int(row['local_type'])==3 else 'text','atUserIds':mention_ids(row.get('source')),
                              'mid':row['mid'],'ts':row['create_time']*1000,'accountStableId':self.own})
                    continue
                if not row['sender']:
                    self.skipped += 1
                    continue
                raw_type = int(row['local_type'])
                base_type = raw_type & 0xffffffff
                body = nt._strip_group_speaker(nt._decode_content(row.get('message_content')), {row['sender']})
                text = body if base_type == 1 else nt.non_text_display(raw_type, row.get('message_content'))
                attachments, media_error = [], ''
                if base_type in (3, 47) or raw_type == ((8 << 32) | 49):
                    try:
                        attachments.append(self.resolve_media(talker, row))
                    except Exception as error:
                        media_error = str(error) if re.fullmatch(r'IMAGE_[A-Z_]+', str(error)) else 'IMAGE_LOCAL_RESOLUTION_FAILED'
                        text += '（媒体未读取：%s）' % media_error
                at_ids = set(mention_ids(row.get('source')))
                has_at_metadata = '<atuserlist>' in nt._decode_content(row.get('source'))
                self.received += 1
                emit({'event': 'message', 'receiver': 'database', 'accountStableId': self.own,
                      'chatName': target['name'], 'chatType': target['kind'], 'chatStableId': talker,
                      'senderStableId': row['sender'], 'senderName': self.names.get(row['sender'], row['sender']),
                      'source': 'friend', 'messageType': 'text', 'text': text, 'mid': row['mid'], 'ts': row['create_time'] * 1000,
                      'atMe': (self.own in at_ids or 'notify@all' in at_ids) if has_at_metadata else None, 'media': attachments, 'mediaError': media_error})
            # Bound seen identities without losing the live overlap window.
            if len(state['seen']) > 4000:
                state['seen'] = {row['mid'] for row in rows if not unconfirmed_outbound(row, self.own)}
        emit({'event': 'db-polled', 'targetCount': len(self.targets), 'receivedCount': self.received, 'unresolvedSenderCount': self.skipped})

    def close(self):
        for connection in self.connections.values():
            connection.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--credentials', required=True)
    p.add_argument('--media-root', required=True)
    args = p.parse_args()
    reader = Reader(args.credentials, args.media_root)
    commands = queue.Queue()
    def listen():
        for line in sys.stdin:
            try:
                commands.put(json.loads(line))
            except ValueError:
                pass
        commands.put({'op': 'stop'})
    threading.Thread(target=listen, daemon=True).start()
    emit({'event': 'db-ready', 'accountStableId': reader.own, 'accountDirectory': reader.account.name,
          'identitySource': 'database', 'readOnly': True})
    try:
        while True:
            try:
                command = commands.get(timeout=2)
                if command.get('op') == 'stop':
                    return
                if command.get('op') == 'configure':
                    emit({'event': 'db-configured', **reader.configure(command)})
                if command.get('op') == 'resolve-media':
                    talker = command.get('talker')
                    response = {'event': 'db-media', 'requestId': command.get('requestId'), 'ok': False}
                    try:
                        if talker not in reader.targets:
                            raise RuntimeError('IMAGE_CHAT_NOT_ALLOWED')
                        row = next((r for r in reversed(reader.rows(talker)) if r['mid'] == command.get('mid')), None)
                        if row is None or int(row['local_type']) & 0xffffffff not in (3,47):
                            raise RuntimeError('IMAGE_MESSAGE_NOT_AVAILABLE')
                        response.update(ok=True, media=[reader.resolve_media(talker,row)])
                    except Exception:
                        response['error'] = 'IMAGE_REFRESH_UNAVAILABLE'
                    emit(response)
                if command.get('op') == 'probe':
                    result = reader.configure(command)
                    reader.poll()  # establishes baselines only; does not replay.
                    counts = {'text': 0, 'image': 0, 'sticker': 0, 'identified': 0}
                    previews = []
                    for talker in reader.targets:
                        rows = reader.rows(talker)
                        for row in rows:
                            kind = int(row['local_type']) & 0xffffffff
                            counts['text' if kind == 1 else 'image' if kind == 3 else 'sticker' if kind == 47 else 'other'] = counts.get('text' if kind == 1 else 'image' if kind == 3 else 'sticker' if kind == 47 else 'other', 0) + 1
                            counts['identified'] += bool(row['sender'])
                        if command.get('testMedia'):
                            for kind in (3, 47):
                                candidate = next((row for row in reversed(rows) if int(row['local_type']) & 0xffffffff == kind), None)
                                if candidate:
                                    try:
                                        previews.append({'ok': True, 'type': kind, **reader.resolve_media(talker, candidate)})
                                    except Exception as error:
                                        previews.append({'ok': False, 'type': kind, 'error': str(error) if re.fullmatch(r'IMAGE_[A-Z_]+', str(error)) else type(error).__name__})
                    result.update({'messageCounts': counts, 'mediaTests': previews, 'shardCount': len(reader.shards)})
                    emit({'event': 'db-probe', 'ok': True, 'readOnly': True, **result})
                    return
            except queue.Empty:
                pass
            reader.poll()
    finally:
        reader.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'[A-Z][A-Z_]{2,100}', str(error)) else type(error).__name__
        emit({'event': 'db-error', 'code': code, 'readOnly': True})
        sys.exit(1)
