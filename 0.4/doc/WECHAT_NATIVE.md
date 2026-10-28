# Optional WeChat channel and kernel restart (0.4 draft)

This patch targets `0.4/` at QQ-agent commit
`18e11d7baf29ce18854ce9ff081c06f8e49fb265`. It does not change `0.5(unfinished)`.
WeChat is disabled by default. QQ remains on its existing OneBot transport.

## Architecture and scope

- `DesktopWechatChannel` receives database events, stores messages with stable
  account/chat identifiers, and calls the existing `orchestrator.onIncoming()`.
  Persona, per-chat memory, model, reply cadence and concurrency remain host-owned.
- Native text, PNG/JPEG sending and group mentions have a **Windows x64 WeChat
  4.1.15.13** profile. Other client versions are not claimed supported. Native
  quoting, files, QQ stickers/pokes and official iLink are not included.
- The read-only Python reader follows the logged-in account's NT message shards.
  It reads allowed conversations independently of the selected window and baselines
  them at startup; it does not replay pre-start messages as new triggers.
- A nonnumeric `wxdesktop_<account-hash>_<chat-hash>` namespace preserves the common
  `group:`/`private:` envelope without casting a WeChat identity to a QQ number.
  Labels resolve through the current account's contacts; ambiguous labels fail.
  Empty private lists reject messages unless the separate all-friends option is on.
- Outbound calls pass through SendQueue, then an authenticated loopback native
  endpoint. An accepted native call is **not** delivery. A new matching server
  message ID confirms it. An uncertain submission holds that conversation until
  manually reconciled; clearing the record never resends it. No keyboard/mouse,
  window activation or automatic fallback is used.
- Received images are decoded from local WeChat media when available; WXGF/sticker
  decoding is supported by the reader. Images not downloaded by WeChat remain
  unavailable. Optional sticker CDN access is off by default. No arbitrary local
  file tool is exposed.
- Common message/search/memory tools reuse host execution. QQ-only tools are
  excluded for WeChat. Extensions can opt in with a tool definition
  `platforms: ['wechat-desktop']` (add `'qq'` if shared). Their sender context is
  scoped to the current conversation and QQ protocol calls are rejected. This is
  compatibility routing, not a sandbox for untrusted extension code.
- QQ owner-identity is not treated as WeChat authentication. This public patch
  intentionally does not export the deployment's privileged commands or identity
  policy. Received database identity is persisted for a later channel-aware policy.
- The Electron shell supervises a separate utility-process kernel. Settings →
  Desktop → Restart kernel drains work and closes HTTP/SSE connections before
  replacing the child process. Window/profile/configuration stay in the shell.
  First installation still requires restarting the desktop application once.

## Source prerequisites and build (maintainer machine)

No third-party runtimes, compiled DLLs, credentials or account databases are
distributed by this patch. The standard QQ Agent dependencies remain unchanged.

1. Supply an existing Windows Python environment at
   `runtime/wechat-db/venv/Scripts/python.exe` under `0.4/`. The tested dependency
   versions are listed in `src/wechat-db/requirements.txt`; a compatible Windows
   `sqlcipher3` native build is required. Dependencies are installed by the
   maintainer, not downloaded by application startup.
2. Use an **x64 Visual Studio Developer Command Prompt** with C++17 support.
   Supply `json.hpp` (nlohmann/json) and `httplib.h` (cpp-httplib) from your own
   reviewed header dependencies, preserving their licenses if redistributed.
   Run from `0.4/`:

   ```cmd
   scripts\build-wechat-native.cmd "C:\headers\json" "C:\headers\httplib"
   ```

   It builds `runtime/wechat-native/NativeMentionBackend-4.1.15.13-r5.dll` and
   `NativeMentionLoader.exe`; the combined backend contains text/images/mentions.
   The smaller text/media source variants are retained for inspection only. The
   build command neither injects a DLL nor sends a message.
3. Configure **your own logged-in account** with an already obtained database
   passphrase. This helper does not discover keys, modify WeChat or log plaintext:

   ```cmd
   runtime\wechat-db\venv\Scripts\python.exe scripts\setup-wechat-local.py --account-path "C:\your-account-directory"
   ```

   For profiles/custom data roots, pass `--data-dir` matching `QQ_AGENT_DATA_DIR`.
   `database.private.json` uses current-user Windows DPAPI; it is not portable to
   another user/device. Native configuration uses a newly generated loopback token,
   exact version and disabled acceptance flags. Never upload either private file.

4. In Settings → WeChat, add the allowed group/contact labels, enable the reader,
   and verify the resolved account/targets locally. UI stores no database key or
   token. Native send remains unavailable until its private `accepted` flag is
   deliberately enabled for this machine's acceptance. At that point the local
   loader can load the compiled DLL into the unique running Weixin main process;
   it does not launch/stop WeChat or operate its windows.
5. On a designated test conversation, verify one text submission against a fresh
   database server receipt. Enable `nativeImagesAccepted` / `nativeMentionsAccepted`
   only when accepting those features separately. Enable the image UI switch to
   permit image sending. The default backend URL is `http://127.0.0.1:30005`;
   do not expose it on a public interface. Do not mark an unknown submission as
   successful or automatically retry it. A version update requires a new profile
   and acceptance, not reusing offsets by changing the version string.

The application writes `runtime/wechat-native/backend-config.path` locally so the
DLL finds this installation's private configuration. It is not included in source.

## Validation and limits of this contribution

The author's customized deployment previously completed real native background
text, image and mention exchanges on WeChat 4.1.15.13. That evidence belongs to
that deployment; this **portable upstream adaptation has not been accepted against
a real logged-in account**. Submit as a draft pending maintainer acceptance.

The patch includes isolated fixtures (no live messages) and a real host boot/stop
test with empty model, disabled WeChat and an unreachable OneBot fixture endpoint:

```cmd
node --test test\kernel-lifecycle.test.mjs test\wechat-channel.test.mjs
node test\kernel-app-smoke.mjs
```

They cover shared incoming dispatch, stable group/private archives, identity/dedupe,
native receipt/uncertainty state, image scoping, unsupported QQ tools, disabled
startup and graceful shutdown with an incomplete HTTP connection. Native binaries
are built separately; building is not evidence of end-to-end delivery.

## Third-party notices

Database-only helpers in `src/wechat-db/vendor/nt_decrypt.py` and `nt_common.py`
follow the MIT reader distributed through
<https://github.com/sourcepro5/WeChatAgent> and
<https://github.com/zhuobichen/weflow-cli>. Local media helper `wechat_media.py`
records weflow-cli source revision `3d56da9`. Complete notices are retained as
`LICENSE-WeChatAgent` and `LICENSE-weflow` alongside the files. Other helper files
implement this channel's local media normalization and sticker adaptation. No
wxauto/wxautox4 package, license loader or compiled third-party runtime is included.
