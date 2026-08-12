export interface GitHubPublisherConfig {
	owner: string;
	repo: string;
	branch: string;
	appId: string;
	postsPath: string;
}

export interface PublishFile {
	path: string;
	content: string | Uint8Array;
}

export interface PublishResult {
	commitSha: string;
	commitUrl: string;
}

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function tokenCacheKey(config: GitHubPublisherConfig): string {
	return `mizuki_github_token:${config.owner}/${config.repo}`;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function utf8ToBase64Url(value: string): string {
	return bytesToBase64Url(new TextEncoder().encode(value));
}

function decodePemBody(pem: string): Uint8Array {
	const base64 = pem
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	if (!base64) throw new Error("没有在 PEM 文件中找到私钥内容");

	try {
		const binary = atob(base64);
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		throw new Error("PEM 私钥格式无效");
	}
}

function encodeDerLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	let remaining = length;
	while (remaining > 0) {
		bytes.unshift(remaining & 0xff);
		remaining >>= 8;
	}
	return [0x80 | bytes.length, ...bytes];
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
	const version = [0x02, 0x01, 0x00];
	const rsaAlgorithmIdentifier = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01,
		0x01, 0x01, 0x05, 0x00,
	];
	const privateKeyOctetString = [
		0x04,
		...encodeDerLength(pkcs1.length),
		...pkcs1,
	];
	const body = [
		...version,
		...rsaAlgorithmIdentifier,
		...privateKeyOctetString,
	];
	return new Uint8Array([0x30, ...encodeDerLength(body.length), ...body]);
}

async function importGitHubPrivateKey(pem: string): Promise<CryptoKey> {
	const decoded = decodePemBody(pem);
	const keyData = pem.includes("BEGIN RSA PRIVATE KEY")
		? wrapPkcs1AsPkcs8(decoded)
		: decoded;
	const keyBuffer = Uint8Array.from(keyData).buffer;

	try {
		return await crypto.subtle.importKey(
			"pkcs8",
			keyBuffer,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"],
		);
	} catch {
		throw new Error("无法读取 GitHub App 私钥，请选择 GitHub 下载的 .pem 文件");
	}
}

export async function createGitHubAppJwt(
	appId: string,
	privateKeyPem: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = utf8ToBase64Url(
		JSON.stringify({ iat: now - 60, exp: now + 8 * 60, iss: appId }),
	);
	const unsignedToken = `${header}.${payload}`;
	const key = await importGitHubPrivateKey(privateKeyPem);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsignedToken),
	);
	return `${unsignedToken}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function githubRequest<T>(
	path: string,
	authorization: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(`${GITHUB_API}${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: authorization,
			"X-GitHub-Api-Version": API_VERSION,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});

	if (!response.ok) {
		let detail = "";
		try {
			const body = (await response.json()) as { message?: string };
			detail = body.message ? `：${body.message}` : "";
		} catch {
			// GitHub occasionally returns an empty error body.
		}
		throw new Error(`GitHub 请求失败 (${response.status})${detail}`);
	}

	return (await response.json()) as T;
}

export function validatePublisherConfig(config: GitHubPublisherConfig): string[] {
	const missing: string[] = [];
	if (!config.owner) missing.push("PUBLIC_GITHUB_OWNER");
	if (!config.repo) missing.push("PUBLIC_GITHUB_REPO");
	if (!config.appId) missing.push("PUBLIC_GITHUB_APP_ID");
	if (!config.branch) missing.push("PUBLIC_GITHUB_BRANCH");
	if (!config.postsPath) missing.push("PUBLIC_GITHUB_POSTS_PATH");
	return missing;
}

export async function getInstallationToken(
	config: GitHubPublisherConfig,
	privateKeyPem: string,
): Promise<string> {
	const cacheKey = tokenCacheKey(config);
	try {
		const cached = sessionStorage.getItem(cacheKey);
		if (cached) {
			const value = JSON.parse(cached) as { token: string; expiresAt: number };
			if (value.token && value.expiresAt > Date.now() + 60_000) {
				return value.token;
			}
		}
	} catch {
		// Ignore unavailable or malformed session storage.
	}

	const jwt = await createGitHubAppJwt(config.appId, privateKeyPem);
	const installation = await githubRequest<{ id: number }>(
		`/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/installation`,
		`Bearer ${jwt}`,
	);
	const access = await githubRequest<{ token: string; expires_at: string }>(
		`/app/installations/${installation.id}/access_tokens`,
		`Bearer ${jwt}`,
		{ method: "POST", body: "{}" },
	);

	try {
		sessionStorage.setItem(
			cacheKey,
			JSON.stringify({
				token: access.token,
				expiresAt: new Date(access.expires_at).getTime(),
			}),
		);
	} catch {
		// Publishing can continue without a token cache.
	}

	return access.token;
}

function encodeRepositoryPath(path: string): string {
	return path
		.split("/")
		.filter(Boolean)
		.map((part) => encodeURIComponent(part))
		.join("/");
}

export async function repositoryPathExists(
	config: GitHubPublisherConfig,
	token: string,
	path: string,
): Promise<boolean> {
	const response = await fetch(
		`${GITHUB_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(config.branch)}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": API_VERSION,
			},
		},
	);
	if (response.status === 404) return false;
	if (!response.ok) {
		throw new Error(`检查文章路径失败 (${response.status})`);
	}
	return true;
}

function normalizeRepositoryPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export async function publishFiles(
	config: GitHubPublisherConfig,
	token: string,
	files: PublishFile[],
	message: string,
): Promise<PublishResult> {
	if (files.length === 0) throw new Error("没有需要发布的文件");

	const repoPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
	const refName = `heads/${config.branch}`;
	const ref = await githubRequest<{ object: { sha: string } }>(
		`${repoPath}/git/ref/${encodeURIComponent(refName)}`,
		`Bearer ${token}`,
	);
	const parentSha = ref.object.sha;
	const parentCommit = await githubRequest<{ tree: { sha: string } }>(
		`${repoPath}/git/commits/${encodeURIComponent(parentSha)}`,
		`Bearer ${token}`,
	);

	const tree = await Promise.all(
		files.map(async (file) => {
			const bytes =
				typeof file.content === "string"
					? new TextEncoder().encode(file.content)
					: file.content;
			const blob = await githubRequest<{ sha: string }>(
				`${repoPath}/git/blobs`,
				`Bearer ${token}`,
				{
					method: "POST",
					body: JSON.stringify({
						content: bytesToBase64(bytes),
						encoding: "base64",
					}),
				},
			);
			return {
				path: normalizeRepositoryPath(file.path),
				mode: "100644",
				type: "blob",
				sha: blob.sha,
			};
		}),
	);

	const nextTree = await githubRequest<{ sha: string }>(
		`${repoPath}/git/trees`,
		`Bearer ${token}`,
		{
			method: "POST",
			body: JSON.stringify({
				base_tree: parentCommit.tree.sha,
				tree,
			}),
		},
	);
	const commit = await githubRequest<{ sha: string; html_url: string }>(
		`${repoPath}/git/commits`,
		`Bearer ${token}`,
		{
			method: "POST",
			body: JSON.stringify({
				message,
				tree: nextTree.sha,
				parents: [parentSha],
			}),
		},
	);
	await githubRequest<Record<string, unknown>>(
		`${repoPath}/git/refs/${encodeURIComponent(refName)}`,
		`Bearer ${token}`,
		{
			method: "PATCH",
			body: JSON.stringify({ sha: commit.sha, force: false }),
		},
	);

	return { commitSha: commit.sha, commitUrl: commit.html_url };
}
