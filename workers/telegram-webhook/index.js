export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // ── GET /messages — agent polls this for new messages ──
    if (request.method === "GET" && url.pathname === "/messages") {
      const list = await env.MESSAGES.list({ prefix: "msg:" });
      const messages = [];
      for (const key of list.keys) {
        const val = await env.MESSAGES.get(key.name, "json");
        if (val) messages.push(val);
      }
      // Sort oldest first
      messages.sort((a, b) => a.date - b.date);
      return Response.json(messages, { headers: cors });
    }

    // ── DELETE /messages — agent calls this after consuming messages ──
    if (request.method === "DELETE" && url.pathname === "/messages") {
      const list = await env.MESSAGES.list({ prefix: "msg:" });
      for (const key of list.keys) {
        await env.MESSAGES.delete(key.name);
      }
      return Response.json({ ok: true, deleted: list.keys.length }, { headers: cors });
    }

    // ── GET / — health check ──
    if (request.method === "GET") {
      return new Response("Telegram webhook is live.", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // ── POST /send — agent sends a message TO Telegram ──
    if (url.pathname === "/send") {
      try {
        const body = await request.json();
        const text = body.text || body.message || body.content || JSON.stringify(body, null, 2);

        const tgResponse = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: text,
              parse_mode: "HTML",
            }),
          }
        );
        const tgResult = await tgResponse.json();

        if (!tgResult.ok) {
          return Response.json({ ok: false, error: tgResult.description }, { status: 502, headers: cors });
        }
        return Response.json({ ok: true, message_id: tgResult.result.message_id }, { headers: cors });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500, headers: cors });
      }
    }

    // ── POST / — Telegram sends incoming messages here (webhook) ──
    try {
      const update = await request.json();

      // Only handle text messages
      const msg = update.message;
      if (!msg || !msg.text) {
        return Response.json({ ok: true });
      }

      // Store in KV with TTL of 1 hour (auto-cleanup)
      const entry = {
        id: msg.message_id,
        from: msg.from?.first_name || "Unknown",
        username: msg.from?.username || null,
        text: msg.text,
        date: msg.date,
        chat_id: msg.chat.id,
      };

      await env.MESSAGES.put(`msg:${msg.message_id}`, JSON.stringify(entry), {
        expirationTtl: 3600,
      });

      return Response.json({ ok: true });
    } catch (err) {
      return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
  },
};
