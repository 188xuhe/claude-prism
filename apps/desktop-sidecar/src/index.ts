import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compileRoutes } from "./compile.js";
import { chatRoutes } from "./chat.js";

const app = new Hono();

app.use("/*", cors());

// Mount routes
app.route("/", compileRoutes);
app.route("/", chatRoutes);

const port = parseInt(process.env.PORT || "3001", 10);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Open-Prism sidecar running on port ${port}`);
