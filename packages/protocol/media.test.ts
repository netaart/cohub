import assert from "node:assert/strict";
import { it } from "node:test";
import { modelImageUrl } from "./src/core/media.js";

it("derives model-sized variants on known CDNs only", () => {
  assert.equal(
    modelImageUrl("https://public.cohub.live/a.png"),
    "https://public.cohub.live/a.png?x-oss-process=image/resize,m_lfit,w_1280,h_1280/quality,q_75/format,webp",
  );
  assert.equal(
    modelImageUrl("https://cca.neta.art/u/a.webp"),
    "https://cca.neta.art/cdn-cgi/image/width=1280,height=1280,fit=scale-down,quality=75,format=webp,onerror=redirect/u/a.webp",
  );
  for (const url of ["https://cdn.example.com/a.png", "https://cca.neta.art/u/a.gif"]) assert.equal(modelImageUrl(url), url);
});
