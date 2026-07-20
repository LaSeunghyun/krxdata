import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const { data, error } = await sb
  .from("state")
  .select("*")
  .eq("key", "live_queue")
  .single();

if (error) {
  console.log("Error:", error.message);
} else {
  console.log("live_queue value:");
  console.log(JSON.stringify(data.value, null, 2));
}

process.exit(0);
