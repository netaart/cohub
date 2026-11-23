import { createGenerationDeclarationLoader } from "@cohub/infra/config-runtime/generation-declarations";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";

const logger = createLogger({ serviceName: "cohub-api" });

const loader = createGenerationDeclarationLoader({
  platformConfigRoot: config.platformConfigRoot,
  redis: redisCommandClient,
  warn: (message) => logger.warn(`[generations] ${message}`),
});

export const loadGenerationDeclarations = loader.loadGenerationDeclarations;
export const loadGenerationDeclaration = loader.loadGenerationDeclaration;
