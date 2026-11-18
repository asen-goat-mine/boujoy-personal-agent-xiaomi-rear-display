# Boujoy Personal Agent · Xiaomi Rear Display

[English](README.md) · [简体中文](README.zh-CN.md)

Give the phone a task and keep the main screen for yourself. On compatible Xiaomi hardware, Boujoy can run an app on a background display while its rear-screen controls keep the assistant within reach. Start on the main screen, enable supported features when ready, and take control at any point.

## Three screens, three different jobs

| Surface | What happens there | Requirements |
| --- | --- | --- |
| Main display | Boujoy reads and acts in the visible Android app. Start here to verify pairing. | Unlocked phone, Phone Use connected |
| Background display | A supported app runs on a separate display so the main screen stays available. | A compatible device and app, Shizuku authorization, Boujoy background accessibility service, and a ready executor |
| Rear screen | Read task progress at a glance while the task runs. | Compatible rear-screen hardware, firmware and rear-progress setting |

If background execution becomes unavailable, the task pauses. Decide whether to continue on the main screen. Lock-screen presentation and rear-display power management have separate device checks. For standard Android phones, see the [main-screen edition](https://github.com/asen-goat-mine/boujoy-personal-agent).

## A task you can watch from start to finish

> “Compare the two sizes of this item. Tell me the displayed price and unit price, show which listing each figure came from, and stop before checkout.”

The Mac plans a read, the phone returns the current screen and available UI elements, and the agent uses that evidence for its next step. Moving to a different listing produces a new observation. The result arrives in the conversation so you can check the numbers. Login, verification and payment can require your hands on the device. A product page that hides its contents may also need your help.

| Another useful request | What to check |
| --- | --- |
| “Read the opening hours on this page and tell me if Saturday is different.” | Ask for the wording shown on screen before relying on the answer. |
| “Draft this reply in the open conversation and stop before sending.” | Review the recipient and text on the phone, then decide whether to send. |
| “I took over halfway through. Tell me what was already done.” | Look at the task, action receipts and current screen before continuing. |

## First run from source

You need an Apple Silicon Mac, Node.js 24+, npm, Python 3.10+ and Android 13+. The initial download includes the pinned Harness and Phone Use client. Use the same edition on both ends.

```sh
git clone https://github.com/asen-goat-mine/boujoy-personal-agent-xiaomi-rear-display.git
cd boujoy-personal-agent-xiaomi-rear-display
npm ci
npm run setup
python3 scripts/prepare-phone-use.py --include-apk
node scripts/verify-distribution.mjs
npm start
```

1. Open `http://127.0.0.1:18892` on the Mac. In **设置 → 连接 → DeepSeek**, enter your own model key. Run a text-only task first to check the model connection.
2. Install the prepared **PhoneUse-1.3.0.apk** on Android and grant the accessibility and connection permissions it requests. Unlock the phone and put it on the same reachable network as the Mac.
3. Copy the HTTPS address shown by Phone Use into **设置 → 连接 → 手机**. Check that the eight-digit pairing code agrees on both screens, then choose that device on the Mac.
4. Ask “What is on my screen?” Confirm that the reply describes the current page and try the stop control before moving on to a multi-step task.

### Chat from Android over a relay

The Boujoy chat app and the Phone Use executor are separate Android components. Build your edition’s chat app with `python3 scripts/build-android.py --test`; the release APK is written to `android/app/build/outputs/apk/release/app-release.apk`. Keep your signing identity for future updates.

Deploy the relay on a server you control. Set its WSS endpoint in **设置 → 异地连接**, install the matching chat APK, then scan the short-lived binding QR code from the Mac. Check chat and stop on Wi‑Fi before testing mobile data. The Mac must remain awake and online. [Relay deployment](deploy/relay/README.md) · [Pairing guide](docs/share/SETUP.md)

## What lives where

| Component | Responsibility |
| --- | --- |
| Mac service | Runs DeepSeek Harness, coordinates tools, stores task history and local Markdown memory. Model credentials are stored in this edition’s macOS Keychain entry. |
| Android | Captures the current device screen and executes supported actions. The Boujoy companion provides chat, progress and controls. |
| Relay | Forwards encrypted device traffic for remote use. Deploy and pair it yourself. |
| Model provider | Receives the context needed for an authorized model request, which can include text and screenshots. Local storage and cloud processing are separate choices. |

## What changed in the current 52 source

- Sent messages appear at the bottom of the chat immediately. Acknowledgements merge by message ID; a failed send restores the right conversation’s draft.
- Every observation still captures a fresh frame. Consecutive identical frames within one observation can reuse successful local OCR. A changed screen is recognized again.
- Identical phone screenshots in one model request can share a single original. Different prices, images and action receipts stay distinguishable. Four identical synthetic screenshots reduced one serialized request from **405 KB to 104 KB**; this measures payload size.

## When something looks wrong

| Symptom | First check |
| --- | --- |
| The Mac cannot see the phone | Reopen Phone Use, read its current HTTPS address and check Wi‑Fi client isolation and accessibility permission. |
| Android chat says the Mac is offline | Check that the Mac is awake, its service is running and both data and control channels reach your relay. |
| Android rejects the update | Compare application ID and signing identity with the installed build. Back up before planning a migration. |

[Detailed troubleshooting](docs/share/TROUBLESHOOTING.md) · [Build and packaging](BUILD.zh-CN.md)

## For contributors

The task engine is in `src/core/`, phone integrations in `src/adapters/`, remote pairing in `src/remote/`, and the Android app in `android/app/`. Edition identity and capability flags live in `distribution.json`. Run `npm test` for the backend and `npm run check` for project checks.

## Reproduce the request-size comparison

Compare the serialized request size against the original public 52 source using synthetic screenshots offline.

```sh
git worktree add --detach ../boujoy-xiaomi-baseline v1.0.52-base
node scripts/bench-model-frame-context.mjs ../boujoy-xiaomi-baseline evidence/vision-fixtures
```

Original Boujoy code is available under the [MIT License](LICENSE). Dependencies, fonts, icons and bundled upstream sources retain their respective licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).
