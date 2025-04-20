import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import jwt from "@tsndr/cloudflare-worker-jwt";
import { z } from "zod";
import { env } from "hono/adapter";

type GithubEnv = {
  CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
};

type GithubIssue = {
  url: string;
  repository_url: string;
  labels_url: string;
  comments_url: string;
  events_url: string;
  html_url: string;
  id: number;
  node_id: string;
  number: number;
  title: string;
  user: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    site_admin: boolean;
  };
  labels: string[];
  state: string;
  locked: boolean;
  assignee: null;
  assignees: [];
  milestone: null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: null;
  author_association: string;
  active_lock_reason: null;
  draft: boolean;
  pull_request: {
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
    merged_at: null;
  };
  body: null;
  reactions: {
    url: string;
    total_count: number;
    "+1": number;
    "-1": number;
    laugh: number;
    hooray: number;
    confused: number;
    heart: number;
    rocket: number;
    eyes: number;
  };
  timeline_url: string;
  performed_via_github_app: null;
  state_reason: null;
};

const getJwt = (client_id: string, privateKey: string) => {
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
    iss: client_id,
  };

  const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });
  return token;
};

const getInstallationAccessToken = async (
  client_id: string,
  privateKey: string,
  installation_id: string,
) => {
  const jwtToken = getJwt(client_id, privateKey);

  const response = await fetch(
    `https://api.github.com/app/installations/${installation_id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    },
  );
  const data = await response.json() as { token: string; expires_at: string };

  return data.token;
};

const app = new Hono()
  .post(
    "/",
    zValidator(
      "form",
      z.object({
        title: z.string(),
        body: z.string(),
        labels: z.array(z.string()),
      }),
    ),
    async (c) => {
      const { title, body, labels } = c.req.valid("form");

      const { CLIENT_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID } =
        env<GithubEnv>(c);

      // base64 encoded private key to utf8, not using buffer
      const privateKey = atob(GITHUB_APP_PRIVATE_KEY);

      const accessToken = await getInstallationAccessToken(
        CLIENT_ID,
        privateKey,
        GITHUB_INSTALLATION_ID,
      );
      const repoOwner = "nthumodifications";
      const repoName = "courseweb";

      const response = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repoName}/issues`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
          body: JSON.stringify({ title, body, labels }),
        },
      );
      const data = await response.json() as GithubIssue;
      return c.json(data);
    },
  )
  .get(
    "/",
    zValidator(
      "query",
      z.object({
        tag: z.string(),
      }),
    ),
    async (c) => {
      const { tag } = c.req.valid("query");
      const { CLIENT_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID } =
        env<GithubEnv>(c);
      const privateKey = atob(GITHUB_APP_PRIVATE_KEY);

      const accessToken = await getInstallationAccessToken(
        CLIENT_ID,
        privateKey,
        GITHUB_INSTALLATION_ID,
      );
      const repoOwner = "nthumodifications";
      const repoName = "courseweb";

      const response = await fetch(
        `https://api.github.com/repos/${repoOwner}/${repoName}/issues?filter=all&labels=${tag}&state=open`,
        {
          method: "GET",
          headers: {
            Authorization: `token ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );
      const data = (await response.json()) as GithubIssue[];
      return c.json(data);
    },
  );

export default app;
