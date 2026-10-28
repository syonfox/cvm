// GraphSync Durable Object: redundant sync server #1 (SpacetimeDB is #2).
// One DO instance per graph uuid. Clients connect via WebSocket, publish
// full-doc snapshots, and every socket in the room gets the update live.
// Latest snapshot also persists in DO storage so late joiners catch up.
//
// Room protocol (JSON over WS):
//   {t:"hello", uuid}            -> server replies {t:"state", seq, doc, at}
//   {t:"publish", uuid, doc}     -> server acks {t:"ack", seq} + broadcasts
//                                    {t:"state", seq, doc, at} to the room
// HTTP:
//   GET  /api/sync/state?uuid=   -> {ok, seq, doc, at}
//   POST /api/sync/publish       -> {ok, seq} (same as WS publish, for curl/race)

export class GraphSync {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(req) {
    const url = new URL(req.url);
    // WebSocket room: /api/sync/ws?uuid=
    if (url.pathname.endsWith("/ws")) {
      const uuid = url.searchParams.get("uuid") || "default";
      const id = this.env.GRAPH_SYNC.idFromName("graph:" + uuid);
      if (id.toString() !== this.state.id.toString()) {
        return this.env.GRAPH_SYNC.get(id).fetch(req);
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      this.sockets.add(server);
      server.serializeAttachment({ uuid });
      const cur = (await this.state.storage.get("snap:" + uuid)) || { seq: 0, doc: null, at: 0 };
      server.send(JSON.stringify({ t: "state", seq: cur.seq, doc: cur.doc, at: cur.at, uuid }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === "GET" && url.pathname.endsWith("/state")) {
      const uuid = url.searchParams.get("uuid") || "";
      const cur = (await this.state.storage.get("snap:" + uuid)) || { seq: 0, doc: null, at: 0 };
      return Response.json({ ok: true, uuid, ...cur, via: "do" });
    }
    if (req.method === "POST" && url.pathname.endsWith("/publish")) {
      let body = {};
      try { body = await req.json(); } catch (_) {}
      const uuid = (body.uuid || "").trim();
      if (!uuid) return Response.json({ ok: false, error: "uuid required" }, { status: 400 });
      const cur = (await this.state.storage.get("snap:" + uuid)) || { seq: 0 };
      const seq = cur.seq + 1;
      const snap = { seq, doc: body.doc || null, at: Date.now() };
      await this.state.storage.put("snap:" + uuid, snap);
      const msg = JSON.stringify({ t: "state", seq, doc: snap.doc, at: snap.at, uuid });
      for (const ws of [...this.sockets]) {
        try { ws.send(msg); } catch (_) { this.sockets.delete(ws); }
      }
      return Response.json({ ok: true, uuid, seq, via: "do" });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    let m = {};
    try { m = JSON.parse(raw); } catch (_) { return; }
    const uuid = (m.uuid || ws.deserializeAttachment()?.uuid || "default").trim();
    if (m.t === "publish" && m.doc !== undefined) {
      const cur = (await this.state.storage.get("snap:" + uuid)) || { seq: 0 };
      const seq = cur.seq + 1;
      const snap = { seq, doc: m.doc, at: Date.now() };
      await this.state.storage.put("snap:" + uuid, snap);
      try { ws.send(JSON.stringify({ t: "ack", seq, uuid, via: "do" })); } catch (_) {}
      const msg = JSON.stringify({ t: "state", seq, doc: snap.doc, at: snap.at, uuid });
      for (const s of [...this.sockets]) {
        if (s === ws) continue;
        try { s.send(msg); } catch (_) { this.sockets.delete(s); }
      }
    } else if (m.t === "hello") {
      const cur = (await this.state.storage.get("snap:" + uuid)) || { seq: 0, doc: null, at: 0 };
      try { ws.send(JSON.stringify({ t: "state", seq: cur.seq, doc: cur.doc, at: cur.at, uuid })); } catch (_) {}
    }
  }

  async webSocketClose(ws) { this.sockets.delete(ws); }
  async webSocketError(ws) { this.sockets.delete(ws); }
}
