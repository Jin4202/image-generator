import { FalSettingsInput } from "@/contracts";
import { getSettingsHost } from "@/server/container";
import { guardOrigin, readJson, respond } from "@/server/http";
import { deleteFalSettings, describeFalSettings, updateFalSettings } from "@/server/settings";
export const runtime = "nodejs";

/** T16: fal key/mode settings. Responses never include the key; changes apply after restarting the server and the worker. */
export async function GET() { return respond(async () => describeFalSettings(getSettingsHost())); }
export async function PUT(request: Request) { return respond(async () => {
  guardOrigin(request);
  const input = await readJson(request, FalSettingsInput);
  return updateFalSettings(getSettingsHost(), input);
}); }
export async function DELETE(request: Request) { return respond(async () => {
  guardOrigin(request);
  return deleteFalSettings(getSettingsHost());
}); }
