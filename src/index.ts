import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import acaCalendar from "./aca-calendar";
import weather from "./weather";
import course from "./course";
import venue from "./venue";
import shortlink from "./shortlink";
import issue from "./issue";
import headlessAis from "./headless-ais";
import planner from "./planner-replication";
import type { D1Database } from "@cloudflare/workers-types";

export type Bindings = {
  DB: D1Database;
};

export const app = new Hono<{ Bindings: Bindings }>()
  .use(
    cors({
      origin:
        process.env.NODE_ENV === "production" ? "https://nthumods.com" : "*",
    }),
  )
  // .use(csrf({ origin: process.env.NODE_ENV === "production" ? 'nthumods.com': 'localhost' }))
  .use(logger())
  .get("/", (c) => {
    return c.text("I AM NTHUMODS UWU");
  })
  .route("/acacalendar", acaCalendar)
  .route("/weather", weather)
  .route("/course", course)
  .route("/venue", venue)
  .route("/shortlink", shortlink)
  .route("/ccxp", headlessAis)
  .route("/issue", issue)
  .route("/planner", planner);

export default app;
