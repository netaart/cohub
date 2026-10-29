import { resolveUploadGroup, type UploadOptions } from "./upload-config.js";
import { ChannelsApi } from "./apis/channels.js";
import { CronJobsApi } from "./apis/cron-jobs.js";
import { GenerationsApi } from "./apis/generations.js";
import { ModelsApi } from "./apis/models.js";
import { PromptsApi } from "./apis/prompts.js";
import { SkillsApi } from "./apis/skills.js";
import { PublicAssetsApi } from "./apis/public-assets.js";
import { SearchApi } from "./apis/search.js";
import { ReferencesApi } from "./apis/references.js";
import { SessionAccessApi } from "./apis/session-access.js";
import { SpaceClient, SpacesApi } from "./apis/spaces.js";
import { createSpaceFileServices, type SpaceFileServices } from "./apis/space-file-urls.js";
import { TasksApi } from "./apis/tasks.js";

import { UserApi } from "./apis/user.js";
import { UsersApi } from "./apis/users.js";
import { PublicInviteApi } from "./apis/invitations.js";
import { ReferralsApi } from "./apis/referrals.js";
import { AppsApi } from "./apis/apps.js";
import { DesktopCommandsApi } from "./apis/desktop-commands.js";
import { AppCommerceApi } from "./apis/app-commerce.js";
import { RoomsApi } from "./apis/rooms.js";
import { HttpTransport, HttpError, type CohubClientOptions, type Fetch } from "./transport.js";
import { resolveApiBaseUrl, resolveExecutionToken } from "./environment.js";

export class CohubHttpClient {
  readonly spaces: SpacesApi;
  readonly channels: ChannelsApi;
  readonly user: UserApi;
  readonly users: UsersApi;
  readonly generations: GenerationsApi;
  readonly models: ModelsApi;
  readonly prompts: PromptsApi;
  readonly skills: SkillsApi;
  readonly publicAssets: PublicAssetsApi;
  readonly sessionAccess: SessionAccessApi;
  readonly search: SearchApi;
  readonly references: ReferencesApi;
  readonly tasks: TasksApi;
  readonly cronJobs: CronJobsApi;
  readonly invite: PublicInviteApi;
  readonly referrals: ReferralsApi;
  readonly apps: AppsApi;
  readonly appCommerce: AppCommerceApi;
  readonly rooms: RoomsApi;

  /** @deprecated Use `apps`. */
  get works(): AppsApi {
    return this.apps;
  }
  /** @deprecated Use `appCommerce`. */
  get workCommerce(): AppCommerceApi {
    return this.appCommerce;
  }
  readonly desktop: DesktopCommandsApi;

  /** @deprecated Use `desktop`. */
  get ui(): DesktopCommandsApi {
    return this.desktop;
  }

  private readonly transport: HttpTransport;
  private readonly fileServices: SpaceFileServices;

  createUploadGroup(upload?: UploadOptions) {
    return resolveUploadGroup(this.transport, upload);
  }

  constructor(options: CohubClientOptions = {}) {
    const apiBaseUrl = resolveApiBaseUrl(options);
    const executionToken = resolveExecutionToken();
    const resolvedOptions = options.getAccessToken || !executionToken
      ? options
      : { ...options, getAccessToken: () => executionToken };
    this.transport = new HttpTransport(resolvedOptions);
    this.fileServices = createSpaceFileServices(this.transport, null);
    this.spaces = new SpacesApi(this.transport);
    this.channels = new ChannelsApi(this.transport);
    this.user = new UserApi(
      this.transport,
      apiBaseUrl,
      options.setStoredAuthToken,
      options.clearStoredAuthToken,
    );
    this.users = new UsersApi(this.transport);
    this.generations = new GenerationsApi(this.transport);
    this.models = new ModelsApi(this.transport);
    this.prompts = new PromptsApi(this.transport);
    this.skills = new SkillsApi(this.transport);
    this.publicAssets = new PublicAssetsApi(this.transport);
    this.sessionAccess = new SessionAccessApi(this.transport);
    this.search = new SearchApi(this.transport);
    this.references = new ReferencesApi(this.transport);
    this.tasks = new TasksApi(this.transport);
    this.cronJobs = new CronJobsApi(this.transport);
    this.invite = new PublicInviteApi(this.transport);
    this.referrals = new ReferralsApi(this.transport);
    this.apps = new AppsApi(this.transport);
    this.appCommerce = new AppCommerceApi(this.transport);
    this.rooms = new RoomsApi(this.transport);
    this.desktop = new DesktopCommandsApi(this.transport);
  }

  space(spaceId: string) {
    return new SpaceClient(spaceId, this.transport, null, this.fileServices);
  }
}

export const createHttpClient = (options?: CohubClientOptions) =>
  new CohubHttpClient(options);

export { HttpTransport, HttpError };
export type { CohubClientOptions, Fetch };
export * from "./types.js";
