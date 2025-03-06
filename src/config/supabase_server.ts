import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/supabase";
import type { Context } from "hono";
import { env } from "hono/adapter";

const supabase_server = (c: Context) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env<{
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
  }>(c);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase credentials not found");
  }
  return createClient<Database>(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
  );
}

export default supabase_server;
