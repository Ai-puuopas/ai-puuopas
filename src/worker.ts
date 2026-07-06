export interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, app: "AI-puuopas", version: "0.2.0" });
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      const formData = await request.formData();
      const question = String(formData.get("question") ?? "").trim();

      return new Response(
        `AI-puuopas v0.2 vastaanotti kysymyksen: ${question || "(tyhjä)"}\n\nSeuraavassa vaiheessa tähän liitetään Workers AI / AI Search.`,
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    return env.ASSETS.fetch(request);
  },
};
