import { launch, type BrowserWorker } from "@cloudflare/playwright";
import { EnvironmentCredentialsProvider } from "../../../packages/studentconsulting/src/credentials";
import { StudentConsultingProvider } from "../../../packages/studentconsulting/src/provider";

export interface ProviderEnv {
  BROWSER: BrowserWorker;
  STUDENTCONSULTING_EMAIL?: string;
  STUDENTCONSULTING_PASSWORD?: string;
  STUDENTCONSULTING_AUTOSUBMIT?: string;
}

export async function withStudentConsultingProvider<T>(
  env: ProviderEnv,
  operation: (provider: StudentConsultingProvider) => Promise<T>,
): Promise<T> {
  const browser = await launch(env.BROWSER);
  const page = await browser.newPage();

  try {
    const credentials = new EnvironmentCredentialsProvider(env);
    const provider = new StudentConsultingProvider({
      page,
      credentials,
      autoSubmit: env.STUDENTCONSULTING_AUTOSUBMIT === "true",
    });

    return await operation(provider);
  } finally {
    await browser.close();
  }
}
