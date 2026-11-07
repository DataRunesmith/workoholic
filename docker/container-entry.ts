// Container entry: the production Worker with e-mail over SMTP when SMTP_HOST
// is set (Cloudflare Email Service does not exist outside Cloudflare). The
// Workflow gets the same env, since the run that creates the monthly .txt
// sends its e-mail from inside the Workflow.
import worker, { JobAutomationWorkflow as ProductionWorkflow } from "../apps/web/src/index";
import { smtpBinding, type SmtpEnv } from "./smtp";

type Env = Parameters<typeof worker.fetch>[1];

function withMail<T extends object>(env: T): T {
  const smtp = env as T & SmtpEnv;
  return smtp.SMTP_HOST ? { ...env, EMAIL: smtpBinding(smtp) } : env;
}

export class JobAutomationWorkflow extends ProductionWorkflow {
  constructor(ctx: ConstructorParameters<typeof ProductionWorkflow>[0], env: Env) {
    super(ctx, withMail(env));
  }
}

export default {
  fetch(request: Request, env: Env) {
    return worker.fetch(request, withMail(env));
  },
  scheduled(controller: ScheduledController, env: Env) {
    return worker.scheduled(controller, withMail(env));
  },
} satisfies ExportedHandler<Env>;
