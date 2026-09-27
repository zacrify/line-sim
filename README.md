# line-sim

A fake LINE Messaging API for local development and tests. You chat as your bot's users on a web page. The simulator sends signed webhooks to your app. Your app replies through the usual LINE API paths.

- No LINE account, no tunnel, no dependencies. Node 20.6 or newer.
- 1:1 chats and groups. Text, images, and files (PDF and others).
- Full API spec at `GET /openapi.json` (OpenAPI 3.1). The server also prints every route when it starts.

## Run

```bash
cp .env.example .env   # set WEBHOOK_URL and CHANNEL_SECRET
pnpm start             # http://localhost:5531
```

Open http://localhost:5531. Add a chat. Type a message as the user.

The default port is `5531`. To use another port, set `PORT` in `.env`, or run `PORT=5540 pnpm start`. If you change the port, change your app's LINE API base URL to match.

## Connect your app

1. **Point your app's LINE API base URL at the simulator.** Use it for both `https://api.line.me` and `https://api-data.line.me`. Example: `http://localhost:5531`.
2. **Give the simulator your webhook URL and channel secret.** Use the same secret your app checks `x-line-signature` with.
   - One channel: set `WEBHOOK_URL` and `CHANNEL_SECRET` in `.env`.
   - More channels: set `CHANNELS` to a JSON array (see `.env.example`).
   - At runtime: `POST /sim/channels`.

The simulator does not check access tokens. Any token works.

## What your app can call

| Method | Path | Does |
| --- | --- | --- |
| POST | `/v2/bot/message/push` | Push messages to a user or group |
| POST | `/v2/bot/message/reply` | Reply with a webhook's `replyToken` (one use) |
| POST | `/v2/bot/chat/markAsRead` | Always returns `{}` |
| GET | `/v2/bot/profile/{userId}` | `{ userId, displayName }` |
| GET | `/v2/bot/group/{groupId}/summary` | `{ groupId, groupName }` |
| GET | `/v2/bot/group/{groupId}/member/{userId}` | `{ userId, displayName }` |
| GET | `/v2/bot/message/{messageId}/content` | The bytes of an image or file a user sent |

The page shows `text` messages, `altText` (for Flex and templates), and images from `originalContentUrl`. Other message types show as `[type]`.

## What the simulator sends to your app

A `POST` to your `webhookUrl`. Header `x-line-signature` is `base64(HMAC-SHA256(secret, raw body))`, the same as LINE.

```json
{
  "destination": "Usimulator",
  "events": [{
    "type": "message",
    "mode": "active",
    "webhookEventId": "3f1c2d9e-...",
    "deliveryContext": { "isRedelivery": false },
    "timestamp": 1790000000000,
    "replyToken": "a1b2c3...",
    "source": { "type": "user", "userId": "U4af4980629..." },
    "message": { "type": "text", "id": "17900000000001234", "text": "สวัสดีครับ", "quoteToken": "9b2e..." }
  }]
}
```

- In a group, `source` is `{ "type": "group", "groupId": "C...", "userId": "U..." }`.
- An image is `{ "type": "image", "id": "...", "contentProvider": { "type": "line" } }`.
- A file is `{ "type": "file", "id": "...", "fileName": "quote.pdf", "fileSize": 20480 }`.
- For an image or a file, download the bytes from `/v2/bot/message/{id}/content`.

Your app must return 2xx. If it does not, the page shows the status and body.

## Drive it from tests

```bash
# start a chat, and keep its "id"
curl -s -X POST localhost:5531/sim/chats -d '{"kind":"user","name":"สมชาย"}'

# send a message as that user (your app gets the webhook)
curl -s -X POST localhost:5531/sim/chats/<id>/messages -d '{"text":"สวัสดี"}'
# → {"status":200,"error":null}

# send a file: data is base64
curl -s -X POST localhost:5531/sim/chats/<id>/messages \
  -d "{\"file\":{\"name\":\"quote.pdf\",\"type\":\"application/pdf\",\"data\":\"$(base64 -i quote.pdf)\"}}"

# see what your app replied
curl -s localhost:5531/sim/chats

# clear all chats between tests
curl -s -X DELETE localhost:5531/sim/chats
```

## Limits

- All state is in memory. A restart clears chats and files. Channels from `.env` stay.
- Only `message` events. No follow, unfollow, join, or postback events.

## Develop

```bash
pnpm test  # node:test, no install needed
```
