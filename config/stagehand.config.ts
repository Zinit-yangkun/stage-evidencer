import type { ConstructorParams } from "@browserbasehq/stagehand";

const stagehandConfig: ConstructorParams = {
  env: "LOCAL",
  modelName: process.env.STAGEHAND_MODEL_NAME,
  modelClientOptions: {
    apiKey: process.env.STAGEHAND_API_KEY,
  },
  enableCaching: true,
  selfHeal: true,
  localBrowserLaunchOptions: {
    headless: process.env.STAGEHAND_HEADLESS !== "false",
  },
};

export default stagehandConfig;
