import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const endpoint = (key: string, accountID: string, namespaceID: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountID}/storage/kv/namespaces/${namespaceID}/values/${key}`;

const app = new Hono()
  .put(
    "/",
    zValidator(
      "query",
      z.object({
        url: z.string().url(),
      }),
    ),
    async (c) => {
      const { url } = c.req.valid("query");
      // generate a random 16-character key
      const key = Array.from(
        { length: 16 },
        () => Math.random().toString(36)[2],
      ).join("");

      const res = await fetch(
        endpoint(
          key,
          process.env.CLOUDFLARE_WORKER_ACCOUNT_ID!,
          process.env.CLOUDFLARE_KV_SHORTLINKS_NAMESPACE!,
        ),
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_KV_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: url,
        },
      ).then((response) => response.json());

      if (!res.success) {
        throw new Error("Failed to create short link");
      }

      return c.text(`https://nthumods.com/l/${key}`);
    },
  )
  .get(
    "/:key",
    zValidator(
      "param",
      z.object({
        key: z.string().length(16),
      }),
    ),
    async (c) => {
      const { key } = c.req.valid("param");
      const text = await fetch(
        endpoint(
          key,
          process.env.CLOUDFLARE_WORKER_ACCOUNT_ID!,
          process.env.CLOUDFLARE_KV_SHORTLINKS_NAMESPACE!,
        ),
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.CLOUDFLARE_KV_API_TOKEN}`,
            "Content-Type": "text/plain",
          },
        },
      ).then((response) => response.text());

      if (!text) {
        throw new Error("Short link not found");
      }
      return c.text(text);
    },
  );

export default app;
