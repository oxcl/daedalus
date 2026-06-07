import { fetchHandler } from "./index";
import { createStorage } from "./storage";

const storage = await createStorage();
const port = parseInt(process.env.PORT || "", 10) || 6767;

export default Bun.serve({
  port,
  fetch: (req) => fetchHandler(req, storage),
});

console.log(`Daedalus running on http://localhost:${port}`);