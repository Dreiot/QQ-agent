// OneBot 传输提供者：把 OneBot v11 事件/动作翻译成归一化模型（DSH §6.2 提供者契约）。
// 事件分派：message / message_sent / notify.poke / group_recall / friend_recall / group_ban；
// meta/心跳忽略。message_sent 自己发的直接 return（发送时已自行留档）。
import { OneBotClient } from './client.js';
import {createModerationActions} from './moderation.js';
let favoritesIdentitySequence = 0;

export function createOneBotProvider({ cfg, log = console, onEvent, onStatus, tokenCandidates, connectionResolver = null, onVerifiedConnection = null, clientFactory = null, portProbe = null, portProbeIntervalMs = 2000 }) {
  const connectionConfig = () => {
    const current = cfg();
    if (typeof connectionResolver === 'function') return connectionResolver(current);
    const value = key => {
      const source = current.onebot;
      return typeof source?.[key] === 'string' ? source[key] : '';
    };
    return { wsUrl: value('wsUrl'), httpUrl: value('httpUrl'), accessToken: value('accessToken'),
      httpToken: value('httpAccessToken'), candidateScope: 'onebot' };
  };
  let currentConnection = connectionConfig();
  const Client = clientFactory ?? OneBotClient;
  let eventSink = onEvent;
  let statusSink = onStatus;
  let latestStatus = { connected: false, error: null };
  const connectionInfo = () => {
    const safeEndpoint = value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return ''; }
    };
    return { mode: currentConnection.mode, accountId: currentConnection.expectedSelfId || null,
      wsUrl: safeEndpoint(currentConnection.wsUrl), httpUrl: safeEndpoint(currentConnection.httpUrl) };
  };
  const client = new Client({
    ...currentConnection,
    getConfig: () => {
      // HTTP calls and health probes can observe a changed account file before
      // the timer does. Their status must describe that same effective binding.
      currentConnection = connectionConfig();
      return currentConnection;
    },
    onEvent: (raw) => dispatch(raw),
    onStatus: (st) => {
      latestStatus = { ...latestStatus, ...st };
      if (!Object.hasOwn(st, 'error') && st.connected === true) latestStatus.error = null;
      if (typeof connectionResolver === 'function') latestStatus.connection = connectionInfo();
      // This observer belongs to the plugin lifecycle; rebinding the host's
      // status sink must not disable durable account selection.
      if (st.transportReady === true) onVerifiedConnection?.(latestStatus);
      statusSink?.(latestStatus);
    },
    log, tokenCandidates,
  });

  // 可选的协议端端口就绪探测；默认适配器使用客户端自身的重连机制。
  // 注入的 provider 不走这里——它的重连节奏由自己负责。
  let probeTimer = null;
  let started = false;
  let lifecycleGeneration = 0;
  let favoritesIdentityKey = null, favoritesIdentity = null;
  function accountIdentity() {
    if (!client.selfId) return null;
    const key = `${lifecycleGeneration}:${client._configurationGeneration ?? 0}:${client.selfId}`;
    if (key !== favoritesIdentityKey) {
      favoritesIdentityKey = key;
      favoritesIdentity = `onebot-favorites-${++favoritesIdentitySequence}`;
    }
    return favoritesIdentity;
  }

  function refreshConfig({ reconnect = started } = {}) {
    const next = connectionConfig();
    const previous = currentConnection;
    currentConnection = next;
    if (typeof client.configure === 'function') client.configure(next, { reconnect });
    else {
      // Preserve injectable client factories while keeping their connection parameters current.
      const wsChanged = ['wsUrl', 'accessToken', 'candidateScope'].some(key => next[key] !== previous[key]);
      Object.assign(client, next, { httpToken: next.scopedCredentials ? next.httpToken : next.httpToken || next.accessToken });
      if (wsChanged && reconnect) client.reconnect?.();
    }
    return next;
  }

  function dispatch(raw) {
    const postType = raw.post_type;
    if (postType === 'meta_event') return; // 心跳/meta 忽略
    if (postType === 'message' || postType === 'message_sent') {
      const selfId = String(client.selfId ?? '');
      const uid = String(raw.user_id ?? '');
      if (postType === 'message_sent' && uid === selfId) {if(raw.message_type==='group')eventSink?.({kind:'group',id:String(raw.group_id),type:'message_observed',event:raw});return;} // 仅供窗口管理观察，不重复入库或触发回复
      const isGroup = raw.message_type === 'group';
      eventSink?.({
        kind: isGroup ? 'group' : 'private',
        id: String(isGroup ? raw.group_id : raw.user_id),
        type: 'message',
        event: raw,
      });
      return;
    }
    if (postType === 'notice') {
      if(raw.notice_type==='group_increase') {eventSink?.({kind:'group',id:String(raw.group_id??''),type:'member_join',event:raw});return;}
      const managementType={group_decrease:'member_leave',group_admin:'admin_changed',group_upload:'group_upload'}[raw.notice_type];
      if(managementType){eventSink?.({kind:'group',id:String(raw.group_id??''),type:managementType,event:raw});return;}
      if (raw.notice_type === 'notify' && raw.sub_type === 'poke') {
        eventSink?.({ kind: raw.group_id != null ? 'group' : 'private', id: String(raw.group_id ?? raw.user_id), type: 'poke', event: raw });
        return;
      }
      if (raw.notice_type === 'group_recall' || raw.notice_type === 'friend_recall') {
        eventSink?.({ kind: raw.group_id != null ? 'group' : 'private', id: String(raw.group_id ?? raw.user_id), type: 'recall', event: raw });
        return;
      }
      if (raw.notice_type === 'group_ban') {
        eventSink?.({ kind: 'group', id: String(raw.group_id ?? ''), type: 'ban', event: raw });
        return;
      }
    }
    if(postType==='request'&&raw.request_type==='group'&&raw.sub_type==='add')eventSink?.({kind:'group',id:String(raw.group_id??''),type:'join_request',event:raw});
  }

  return {
    id: 'onebot',
    client,
    get selfId() { return client.selfId ? String(client.selfId) : null; },
    get selfNickname() { return typeof client.selfNickname === 'string' ? client.selfNickname : ''; },
    // 内核可在构造后绑定回调，允许 transportFactory 统一掌握 provider 生命周期。
    bind({ onEvent: nextEvent, onStatus: nextStatus } = {}) {
      if (typeof nextEvent === 'function') eventSink = nextEvent;
      if (typeof nextStatus === 'function') statusSink = nextStatus;
      return this;
    },
    async start() {
      if (started) return;
      refreshConfig({ reconnect: false });
      started = true;
      const generation = ++lifecycleGeneration;
      try {
        await client.connect();
      } catch (error) {
        if (generation === lifecycleGeneration) started = false;
        throw error;
      }
      if (!started || generation !== lifecycleGeneration) return;
      if (typeof portProbe === 'function' && portProbeIntervalMs > 0) {
        // 每代单独持有互斥闸，旧探测的 finally 不得解锁新一代。
        let probeInFlight = false;
        probeTimer = setInterval(async () => {
          if (!started || generation !== lifecycleGeneration || probeInFlight) return;
          probeInFlight = true;
          try {
            // Account files can change without an Agent settings event. Refresh
            // healthy connections too; unchanged bindings never replace a socket.
            const connection = refreshConfig({ reconnect: typeof client.configure === 'function' });
            if (connection.connectionError || client.connected || client._reconnectTimer || client.ws?.readyState === 0) return;
            const ready = await portProbe(connection.wsUrl);
            const fresh = connectionConfig();
            const sameConnection = ['wsUrl', 'accessToken', 'candidateScope', 'bindingKey', 'expectedSelfId', 'connectionError'].every(key => fresh[key] === connection[key]);
            if (started && generation === lifecycleGeneration && sameConnection && ready && !client.connected) client.reconnect?.();
          } catch { /* 探测失败等下一轮 */ } finally { probeInFlight = false; }
        }, portProbeIntervalMs);
        probeTimer.unref?.();
      }
    },
    async stop() {
      started = false;
      ++lifecycleGeneration;
      if (probeTimer !== null) { clearInterval(probeTimer); probeTimer = null; }
      await client.close();
    },
    refreshConfig,
    reconnect() { if (started) { refreshConfig({ reconnect: false }); return client.reconnect?.(); } },
    status() {
      return {
        ...latestStatus,
        id: 'onebot',
        connected: !!client.connected,
        selfId: client.selfId ? String(client.selfId) : null,
        selfNickname: typeof client.selfNickname === 'string' ? client.selfNickname : '',
        error: latestStatus.error ?? client.error ?? null,
        ...(typeof connectionResolver === 'function' ? { connection: connectionInfo() } : {}),
      };
    },
    get connected() { return !!client.connected; },
    get everConnected() { return !!client.selfId || !!client.connected; },
    /** 归一化段 → OneBot 消息段（发送侧唯一映射点）。 */
    toPlatformSegments(segments) {
      if (!Array.isArray(segments) || segments.length === 0) throw new Error('OneBot 发送失败：消息段为空');
      // 一条消息必须完整转换；静默跳过未知段会把媒体发送误报成成功。
      return segments.map(toOneBotSegment);
    },
    async send(chatKey, segments, { replyToMessageId = null, signal } = {}) {
      const match = typeof chatKey === 'string' ? chatKey.match(/^(?:qq:)?(group|private):([1-9]\d*)$/) : null;
      if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('OneBot 发送失败：会话 chatKey 无效');
      const [, kind, id] = match;
      const segs = this.toPlatformSegments(segments);
      if (!segs.some((s) => s.type !== 'reply' && (s.type !== 'text' || s.data.text.length > 0))) throw new Error('OneBot 发送失败：消息内容为空');
      if (replyToMessageId != null && replyToMessageId !== '') segs.unshift({ type: 'reply', data: { id: signedMessageId(replyToMessageId, '引用消息段') } });
      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = kind === 'group' ? { group_id: Number(id), message: segs } : { user_id: Number(id), message: segs };
      const res = await client.call(action, params, { signal });
      if ((res?.status != null && res.status !== 'ok') || (res?.retcode != null && res.retcode !== 0 && res.retcode !== '0')) {
        throw new Error(`OneBot ${action} 失败：retcode=${res?.retcode ?? res?.status} ${res?.wording ?? res?.message ?? ''}`.trim());
      }
      const msgId = res?.data?.message_id;
      // 没有协议端确认的 ID，队列不得留档、计入额度或记住去重指纹。
      signedMessageId(msgId, '协议端返回的 message_id');
      return [{ msgId }];
    },
    actions: {
      // Opaque account/lifecycle identity, without exposing credentials or QQ metadata.
      getAccountIdentity: accountIdentity,
      ...createModerationActions({client,currentIdentity:accountIdentity}),
      async poke(chatKey, { groupId, userId } = {}) {
        const kind = chatKey.split(':')[0];
        if (kind === 'group') {
          await client.call('send_poke', { group_id: Number(groupId ?? chatKey.split(':').pop()), user_id: Number(userId) });
        } else {
          await client.call('friend_poke', { user_id: Number(userId ?? chatKey.split(':').pop()) });
        }
        return true;
      },
      async recall(messageId) { await client.call('delete_msg', { message_id: Number(messageId) }); },
      async getChatInfo(chatKey) {
        const [kind, id] = [chatKey.split(':')[0], chatKey.split(':').pop()];
        return kind === 'group'
          ? (await client.call('get_group_info', { group_id: Number(id) }))?.data
          : (await client.call('get_stranger_info', { user_id: Number(id) }))?.data;
      },
      async getMembers(groupId) { return (await client.call('get_group_member_list', { group_id: Number(groupId) }))?.data ?? []; },
      async getGroupMemberInfo(groupId, userId, { signal } = {}) {
        const validId = value => ['string', 'number'].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
        if (!validId(groupId) || !validId(userId)) throw new Error('群成员查询的群号或 QQ 号无效');
        const identity = accountIdentity(), generation = lifecycleGeneration, configuration = client._configurationGeneration;
        if (signal?.aborted) throw Object.assign(new Error('群成员查询已取消'), { name: 'AbortError' });
        const result = await client.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: false }, { signal });
        if (signal?.aborted || generation !== lifecycleGeneration || configuration !== client._configurationGeneration || identity !== accountIdentity()) {
          throw Object.assign(new Error('群成员查询期间账号、接入配置或协议生命周期已更改'), { name: 'AbortError' });
        }
        if ((result?.status != null && result.status !== 'ok') || (result?.retcode != null && result.retcode !== 0 && result.retcode !== '0')) throw new Error('群成员查询失败');
        const member = result?.data;
        if (!member || typeof member !== 'object' || Array.isArray(member)) return null;
        if (member.user_id != null && String(member.user_id) !== String(userId)) throw new Error('群成员查询返回的 QQ 号不匹配');
        return { userId: String(member.user_id ?? userId), card: typeof member.card === 'string' ? member.card : '', nickname: typeof member.nickname === 'string' ? member.nickname : '' };
      },
      async getForward(messageId) { return (await client.call('get_forward_msg', { message_id: Number(messageId) }))?.data; },
      async getVideo(file) { return (await client.call('get_video', { file: String(file) }))?.data; },
      async getFile(file) { return (await client.call('get_file', { file: String(file) }))?.data; },
      async getRecord(file) { return (await client.call('get_record', { file: String(file), out_format: 'mp3' }))?.data; },
      async getImage(file) { return (await client.call('get_image', { file: String(file) }))?.data ?? null; },

      // ---- 归一化动作（控制台/调度器消费，QQ 语义关在 provider 内）----

      /** 群列表 → [{id, name}]（供 /api/onebot/groups 白名单勾选）。 */
      async listGroups({ signal } = {}) {
        const res = await client.call('get_group_list', {}, { signal });
        return (res?.data ?? []).map((g) => ({ id: String(g.group_id), name: g.group_name || String(g.group_id) }));
      },
      /** 好友列表 → [{id, name}]（remark 优先，同 0.4 口径）。 */
      async listFriends({ signal } = {}) {
        const res = await client.call('get_friend_list', {}, { signal });
        return (res?.data ?? []).map((f) => ({ id: String(f.user_id), name: f.remark || f.nickname || String(f.user_id) }));
      },
      /** 群成员 → [{userId, nickname, card}]（card=群名片，QQ 独有概念）。 */
      async getGroupMembers(groupId) {
        const res = await client.call('get_group_member_list', { group_id: Number(groupId) });
        return (res?.data ?? []).map((m) => ({ userId: String(m.user_id), nickname: m.nickname ?? '', card: m.card ?? '' }));
      },
      /** 群名 → string（查询失败/超时由调用方处理）。 */
      async getGroupName(chatKey, { signal } = {}) {
        const id = Number(String(chatKey).split(':').pop());
        const res = await client.call('get_group_info', { group_id: id }, { signal });
        return String(res?.data?.group_name ?? '').trim();
      },
      /**
       * 自己在群里的禁言状态 → { muted }。
       * SUSPECT 复刻 0.4/orchestrator：判据必须"到期时刻在未来"——
       * 写成 t>0 会把已解禁的群永久判为禁言（orchestrator.js 原注释）。
       * 返回 null = 平台无法判定（如私聊），调用方按未禁言处理。
       */
      async getSelfMemberInfo(chatKey) {
        const kind = chatKey.split(':')[0];
        if (kind !== 'group') return null;
        const gid = Number(chatKey.split(':').pop());
        const self = client.selfId != null ? Number(client.selfId) : NaN;
        if (!Number.isFinite(self)) return null;
        const res = await client.call('get_group_member_info', { group_id: gid, user_id: self, no_cache: true });
        const t = Number(res?.data?.shut_up_timestamp ?? 0);
        return { muted: t * 1000 > Date.now() };
      },
    },
    segmentSupport: { text: true, at: true, image: true, face: true, record: true, video: true, reply: true, json: true, forward: true, file: true, poke: true },
  };
}

function scalar(value, field) {
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`OneBot 消息段 ${field} 无效`);
  return value;
}

function signedMessageId(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^-?[1-9]\d*$/.test(String(value))) {
    throw new Error(`OneBot 发送失败：${field} 无效（无法确认消息）`);
  }
  return String(value);
}

function toOneBotSegment(segment) {
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) throw new Error('OneBot 消息段必须是对象');
  const type = segment.type;
  const native = segment.data && typeof segment.data === 'object' && !Array.isArray(segment.data) ? segment.data : {};
  const value = (key) => segment[key] ?? native[key];
  const options = (data, keys) => {
    for (const key of keys) {
      // image.data.type 是 flash 等图片选项，不能用段本身的 type='image' 覆盖。
      const option = key === 'type' ? native[key] : value(key);
      if (option != null) data[key] = scalar(option, `${type}.${key}`);
    }
    return { type, data };
  };
  switch (type) {
    case 'text': {
      const text = value('text');
      if (typeof text !== 'string') throw new Error('OneBot text 消息段缺少文本');
      return { type, data: { text: escapeCq(text) } };
    }
    case 'at': {
      const id = segment.id ?? native.qq;
      if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && !Number.isSafeInteger(id)) || (id !== 'all' && !/^[1-9]\d*$/.test(String(id)))) throw new Error('OneBot at 消息段 id 无效');
      return { type, data: { qq: String(id) } };
    }
    case 'face': {
      const id = value('id');
      if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && !Number.isSafeInteger(id)) || !/^(?:0|[1-9]\d*)$/.test(String(id))) throw new Error('OneBot face 消息段 id 无效');
      return { type, data: { id: String(id) } };
    }
    case 'reply': return { type, data: { id: signedMessageId(segment.id ?? segment.msgId ?? native.id, 'reply 消息段 id') } };
    case 'image':
    case 'record':
    case 'video':
    case 'file': {
      const file = type === 'image' ? segment.url ?? segment.file ?? native.file ?? native.url : segment.file ?? segment.url ?? native.file ?? native.url;
      if (typeof file !== 'string' || !file.trim()) throw new Error(`OneBot ${type} 消息段缺少 file/url`);
      const fields = type === 'image' ? ['type', 'summary', 'sub_type', 'cache', 'proxy', 'timeout']
        : type === 'record' ? ['magic', 'cache', 'proxy', 'timeout']
          : type === 'video' ? ['thumb', 'name', 'cache', 'proxy', 'timeout'] : ['name', 'cache', 'proxy', 'timeout'];
      // file 与 forward 是 QQ 协议端扩展；不拆成额外动作，失败由该次发送明确返回。
      return options({ file }, fields);
    }
    case 'json': {
      const payload = Object.hasOwn(native, 'data') && Object.keys(native).length === 1 ? native.data : segment.data;
      let json;
      try {
        json = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (!json) throw new Error();
        JSON.parse(json);
      } catch { throw new Error('OneBot JSON 消息段 data 不是有效 JSON'); }
      return { type, data: { data: json } };
    }
    case 'forward': {
      const id = value('id');
      if (!['string', 'number'].includes(typeof id) || (typeof id === 'number' && !Number.isSafeInteger(id)) || !String(id).trim()) throw new Error('OneBot forward 消息段缺少资源 id');
      return { type, data: { id: String(id) } };
    }
    default: throw new Error(`OneBot 不支持消息段类型：${String(type)}`);
  }
}

// 发送侧 CQ 转义（防用户文本里的 [CQ: 被网关误解析）
function escapeCq(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}
