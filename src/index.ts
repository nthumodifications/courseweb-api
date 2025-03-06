import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { csrf } from "hono/csrf";

import acaCalendar from "./aca-calendar";
import weather from "./weather";
import course from "./course";
import venue from "./venue";
import shortlink from "./shortlink";
import issue from "./issue";
import headlessAis from "./headless-ais";

export const app = new Hono()
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
  .route("/issue", issue);

export default app
