<script lang="ts">
	import { onDestroy, tick } from "svelte";
	import { marked } from "marked";
	import sanitizeHtml from "sanitize-html";
	import {
		getInstallationToken,
		publishFiles,
		repositoryPathExists,
		validatePublisherConfig,
		type GitHubPublisherConfig,
		type PublishFile,
	} from "../../../lib/github-app-publisher";

	let { config }: { config: GitHubPublisherConfig } = $props();

	type LocalImage = {
		id: string;
		file: File;
		filename: string;
		previewUrl: string;
	};

	const today = () => {
		const now = new Date();
		const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
		return local.toISOString().slice(0, 10);
	};

	let title = $state("");
	let slug = $state("");
	let published = $state(today());
	let updated = $state("");
	let description = $state("");
	let category = $state("");
	let tagsText = $state("");
	let author = $state("");
	let alias = $state("");
	let permalink = $state("");
	let externalCover = $state("");
	let markdown = $state("## 开始写作\n\n在这里输入正文。\n");
	let draft = $state(false);
	let pinned = $state(false);
	let comment = $state(true);
	let showPreview = $state(false);
	let localImages = $state<LocalImage[]>([]);
	let coverImageId = $state("");
	let privateKey = $state("");
	let keyFilename = $state("");
	let publishing = $state(false);
	let status = $state("");
	let error = $state("");
	let commitUrl = $state("");
	let textarea = $state<HTMLTextAreaElement>(null!);
	let keyInput = $state<HTMLInputElement>(null!);
	let imageInput = $state<HTMLInputElement>(null!);
	let markdownInput = $state<HTMLInputElement>(null!);

	const missingConfig = $derived(validatePublisherConfig(config));
	const previewHtml = $derived.by(() => {
		let previewMarkdown = markdown;
		for (const image of localImages) {
			previewMarkdown = previewMarkdown.replaceAll(
				`./${image.filename}`,
				image.previewUrl,
			);
		}
		return sanitizeHtml(marked.parse(previewMarkdown, { async: false }) as string, {
			allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
			allowedAttributes: {
				...sanitizeHtml.defaults.allowedAttributes,
				img: ["src", "alt", "title", "width", "height"],
				code: ["class"],
			},
			allowedSchemes: ["http", "https", "data", "blob"],
		});
	});

	onDestroy(() => {
		for (const image of localImages) URL.revokeObjectURL(image.previewUrl);
	});

	function normalizeSlug(value: string): string {
		const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (!normalized) throw new Error("请填写文章 slug");
		if (normalized.length > 160) throw new Error("slug 不能超过 160 个字符");
		if (/[\u0000-\u001f<>:"|?*#]/.test(normalized)) {
			throw new Error("slug 包含不安全字符");
		}
		const segments = normalized.split("/");
		if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
			throw new Error("slug 路径无效");
		}
		return normalized;
	}

	function yamlString(value: string): string {
		return JSON.stringify(value);
	}

	function buildFrontmatter(cover: string): string {
		const tags = tagsText
			.split(/[,，]/)
			.map((tag) => tag.trim())
			.filter(Boolean);
		const lines = [
			"---",
			`title: ${yamlString(title.trim())}`,
			`published: ${published}`,
		];
		if (updated) lines.push(`updated: ${updated}`);
		if (description.trim()) lines.push(`description: ${yamlString(description.trim())}`);
		if (cover) lines.push(`image: ${yamlString(cover)}`);
		if (tags.length) lines.push(`tags: [${tags.map(yamlString).join(", ")}]`);
		if (category.trim()) lines.push(`category: ${yamlString(category.trim())}`);
		if (author.trim()) lines.push(`author: ${yamlString(author.trim())}`);
		if (alias.trim()) lines.push(`alias: ${yamlString(alias.trim().replace(/^\/+|\/+$/g, ""))}`);
		if (permalink.trim()) lines.push(`permalink: ${yamlString(permalink.trim().replace(/^\/+|\/+$/g, ""))}`);
		lines.push(`draft: ${draft}`);
		lines.push(`pinned: ${pinned}`);
		lines.push(`comment: ${comment}`);
		lines.push("---", "", markdown.trim(), "");
		return lines.join("\n");
	}

	async function hashFilename(file: File): Promise<string> {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		const hash = Array.from(digest)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 20);
		const originalExtension = file.name.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase();
		const mimeExtension: Record<string, string> = {
			"image/jpeg": ".jpg",
			"image/png": ".png",
			"image/webp": ".webp",
			"image/gif": ".gif",
			"image/avif": ".avif",
		};
		const extension = originalExtension || mimeExtension[file.type] || ".img";
		return `${hash}${extension}`;
	}

	async function chooseImages(files: FileList | null) {
		if (!files) return;
		error = "";
		const next = [...localImages];
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > 20 * 1024 * 1024) {
				error = `${file.name} 超过 20MB，未添加`;
				continue;
			}
			const filename = await hashFilename(file);
			if (!next.some((image) => image.filename === filename)) {
				next.push({
					id: crypto.randomUUID(),
					file,
					filename,
					previewUrl: URL.createObjectURL(file),
				});
			}
		}
		localImages = next;
		imageInput.value = "";
	}

	async function insertImage(image: LocalImage) {
		const snippet = `![${image.file.name.replace(/\.[^.]+$/, "")}](./${image.filename})`;
		const start = textarea.selectionStart ?? markdown.length;
		const end = textarea.selectionEnd ?? start;
		markdown = `${markdown.slice(0, start)}${snippet}${markdown.slice(end)}`;
		await tick();
		textarea.focus();
		textarea.setSelectionRange(start + snippet.length, start + snippet.length);
	}

	function removeImage(image: LocalImage) {
		URL.revokeObjectURL(image.previewUrl);
		localImages = localImages.filter((item) => item.id !== image.id);
		if (coverImageId === image.id) coverImageId = "";
	}

	async function importPrivateKey(files: FileList | null) {
		const file = files?.[0];
		if (!file) return;
		privateKey = await file.text();
		keyFilename = file.name;
		status = "私钥已载入浏览器内存，可以发布。";
		error = "";
		keyInput.value = "";
	}

	async function importMarkdown(files: FileList | null) {
		const file = files?.[0];
		if (!file) return;
		const source = await file.text();
		markdown = source.replace(/^---\s*[\r\n]+[\s\S]*?[\r\n]+---\s*[\r\n]*/, "");
		markdownInput.value = "";
	}

	async function publish() {
		error = "";
		commitUrl = "";
		status = "";

		try {
			if (missingConfig.length) {
				throw new Error(`缺少 Vercel 环境变量：${missingConfig.join(", ")}`);
			}
			if (!title.trim()) throw new Error("请填写文章标题");
			if (!published) throw new Error("请选择发布日期");
			if (!markdown.trim()) throw new Error("文章正文不能为空");
			const safeSlug = normalizeSlug(slug);
			if (!privateKey) {
				status = "请先选择 GitHub App 的 .pem 私钥，然后再次点击发布。";
				keyInput.click();
				return;
			}

			publishing = true;
			status = "正在向 GitHub 申请临时令牌…";
			const token = await getInstallationToken(config, privateKey);
			const postsPath = config.postsPath.replace(/^\/+|\/+$/g, "");
			const articleDirectory = `${postsPath}/${safeSlug}`;
			const articlePath = `${articleDirectory}/index.md`;

			status = "正在检查文章路径…";
			const [directoryArticleExists, flatMarkdownExists, flatMdxExists] = await Promise.all([
				repositoryPathExists(config, token, articlePath),
				repositoryPathExists(config, token, `${postsPath}/${safeSlug}.md`),
				repositoryPathExists(config, token, `${postsPath}/${safeSlug}.mdx`),
			]);
			if (flatMarkdownExists || flatMdxExists) {
				throw new Error(`已经存在同名的扁平文章 ${safeSlug}.md(x)，请更换 slug 或先迁移旧文章`);
			}
			if (directoryArticleExists && !window.confirm("这个 slug 已经存在。确定覆盖文章正文并提交新版本吗？")) {
				status = "已取消发布。";
				return;
			}

			const selectedCover = localImages.find((image) => image.id === coverImageId);
			const cover = selectedCover ? `./${selectedCover.filename}` : externalCover.trim();
			const files: PublishFile[] = [
				{ path: articlePath, content: buildFrontmatter(cover) },
			];
			for (const image of localImages) {
				files.push({
					path: `${articleDirectory}/${image.filename}`,
					content: new Uint8Array(await image.file.arrayBuffer()),
				});
			}

			status = "正在创建文章文件和 Git 提交…";
			const result = await publishFiles(
				config,
				token,
				files,
				directoryArticleExists ? `更新文章: ${safeSlug}` : `发布文章: ${safeSlug}`,
			);
			commitUrl = result.commitUrl;
			status = "GitHub 提交成功。Vercel 正在重新部署，请稍后刷新网站。";
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "发布失败，请稍后重试";
			status = "";
		} finally {
			publishing = false;
		}
	}
</script>

<div class="publisher-shell">
	{#if missingConfig.length}
		<div class="notice error-notice">
			<strong>发布功能尚未配置</strong>
			<span>请在 Vercel 添加：{missingConfig.join("、")}，然后重新部署一次。</span>
		</div>
	{/if}

	<div class="topbar">
		<div>
			<p class="eyebrow">MIZUKI BROWSER PUBLISHER</p>
			<h1>写文章</h1>
			<p>文章和图片会直接提交到 GitHub，随后由 Vercel 自动发布。</p>
		</div>
		<div class="top-actions">
			<input bind:this={markdownInput} class="hidden-input" type="file" accept=".md,.markdown,.txt" onchange={(event) => importMarkdown(event.currentTarget.files)} />
			<button class="secondary" type="button" onclick={() => markdownInput.click()}>导入 Markdown</button>
			<button class:active={showPreview} class="secondary" type="button" onclick={() => (showPreview = !showPreview)}>
				{showPreview ? "返回编辑" : "预览正文"}
			</button>
		</div>
	</div>

	<div class="editor-grid" data-pagefind-ignore="all">
		<section class="editor-card main-editor">
			<div class="field-row">
				<label class="grow">标题<input bind:value={title} placeholder="文章标题" /></label>
				<label>Slug<input bind:value={slug} placeholder="例如：hello-world" /></label>
			</div>

			{#if showPreview}
				<div class="preview markdown-body">{@html previewHtml}</div>
			{:else}
				<label class="body-label">Markdown 正文
					<textarea bind:this={textarea} bind:value={markdown} spellcheck="false"></textarea>
				</label>
			{/if}
		</section>

		<aside class="sidebar">
			<section class="editor-card">
				<h2>文章信息</h2>
				<div class="field-row">
					<label>发布日期<input bind:value={published} type="date" /></label>
					<label>更新日期<input bind:value={updated} type="date" /></label>
				</div>
				<label>摘要<textarea class="small-textarea" bind:value={description} placeholder="用于文章卡片和 SEO"></textarea></label>
				<label>标签<input bind:value={tagsText} placeholder="Astro, 随笔, 教程" /></label>
				<div class="field-row">
					<label>分类<input bind:value={category} placeholder="技术" /></label>
					<label>作者<input bind:value={author} placeholder="可选" /></label>
				</div>
				<label>远程封面 URL<input bind:value={externalCover} placeholder="https://…（本地封面优先）" /></label>
				<details>
					<summary>高级链接设置</summary>
					<label>Alias<input bind:value={alias} placeholder="可选，位于 /posts/ 下" /></label>
					<label>Permalink<input bind:value={permalink} placeholder="可选，例如 notes/hello" /></label>
				</details>
				<div class="checks">
					<label><input bind:checked={draft} type="checkbox" /> 草稿</label>
					<label><input bind:checked={pinned} type="checkbox" /> 置顶</label>
					<label><input bind:checked={comment} type="checkbox" /> 评论</label>
				</div>
			</section>

			<section class="editor-card">
				<div class="section-heading">
					<div><h2>文章图片</h2><p>图片会和文章一起提交。</p></div>
					<input bind:this={imageInput} class="hidden-input" type="file" accept="image/*" multiple onchange={(event) => chooseImages(event.currentTarget.files)} />
					<button class="secondary compact" type="button" onclick={() => imageInput.click()}>添加</button>
				</div>
				{#if localImages.length === 0}
					<p class="empty">尚未添加本地图片</p>
				{:else}
					<ul class="image-list">
						{#each localImages as image (image.id)}
							<li>
								<div><strong>{image.file.name}</strong><span>{image.filename}</span></div>
								<div class="image-actions">
									<button type="button" onclick={() => insertImage(image)}>插入</button>
									<button class:chosen={coverImageId === image.id} type="button" onclick={() => (coverImageId = coverImageId === image.id ? "" : image.id)}>封面</button>
									<button class="danger" type="button" onclick={() => removeImage(image)}>移除</button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="editor-card publish-card">
				<input bind:this={keyInput} class="hidden-input" type="file" accept=".pem" onchange={(event) => importPrivateKey(event.currentTarget.files)} />
				<div class="key-row">
					<div><h2>GitHub 授权</h2><p>{keyFilename || "私钥不会上传到 Vercel"}</p></div>
					<button class="secondary compact" type="button" onclick={() => keyInput.click()}>{keyFilename ? "更换私钥" : "选择私钥"}</button>
				</div>
				<button class="publish" type="button" disabled={publishing || missingConfig.length > 0} onclick={publish}>
					{publishing ? "正在发布…" : "发布到 GitHub"}
				</button>
				{#if status}<p class="status">{status}</p>{/if}
				{#if error}<p class="error-message">{error}</p>{/if}
				{#if commitUrl}<a class="commit-link" href={commitUrl} target="_blank" rel="noreferrer">查看 GitHub 提交 →</a>{/if}
			</section>
		</aside>
	</div>
</div>

<style>
	:global(*) { box-sizing: border-box; }
	.publisher-shell { width: 100%; color: var(--text-color, inherit); }
	.topbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 1.5rem; margin-bottom: 1rem; }
	.topbar h1 { margin: .15rem 0 .25rem; font-size: 2rem; line-height: 1.1; }
	.topbar p { margin: 0; opacity: .62; }
	.eyebrow { font-size: .7rem; letter-spacing: .16em; color: var(--primary); font-weight: 800; }
	.top-actions, .image-actions, .checks { display: flex; gap: .5rem; flex-wrap: wrap; }
	.editor-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(19rem, .8fr); gap: 1rem; align-items: start; }
	.sidebar { display: grid; gap: 1rem; }
	.editor-card { border-radius: var(--radius-large, 1rem); background: var(--card-bg); border: 1px solid var(--line-divider, rgba(128,128,128,.18)); padding: 1rem; box-shadow: 0 12px 40px rgba(0,0,0,.04); }
	.editor-card h2 { font-size: 1rem; margin: 0 0 .75rem; }
	.main-editor { min-height: 49rem; display: flex; flex-direction: column; }
	.field-row { display: flex; gap: .75rem; }
	.field-row > label { flex: 1; }
	.grow { flex: 2 !important; }
	label { display: grid; gap: .35rem; margin-bottom: .75rem; font-size: .78rem; font-weight: 700; opacity: .86; }
	input, textarea { width: 100%; border: 1px solid var(--line-divider, rgba(128,128,128,.24)); border-radius: .72rem; background: color-mix(in srgb, var(--card-bg) 88%, transparent); color: inherit; padding: .72rem .8rem; outline: none; font: inherit; }
	input:focus, textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 14%, transparent); }
	.body-label { flex: 1; margin: 0; }
	.body-label textarea { min-height: 43rem; height: 100%; resize: vertical; font-family: var(--font-jetbrains-mono, ui-monospace), monospace; font-size: .88rem; line-height: 1.7; }
	.small-textarea { min-height: 5rem; resize: vertical; }
	button { border: 0; cursor: pointer; font: inherit; }
	button:disabled { cursor: not-allowed; opacity: .45; }
	.secondary { border: 1px solid var(--line-divider, rgba(128,128,128,.2)); background: var(--card-bg); color: inherit; padding: .62rem .9rem; border-radius: .72rem; font-weight: 700; }
	.secondary:hover, .secondary.active { border-color: var(--primary); color: var(--primary); }
	.compact { padding: .45rem .65rem; font-size: .76rem; }
	.hidden-input { display: none; }
	.section-heading, .key-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
	.section-heading h2, .key-row h2 { margin-bottom: .15rem; }
	.section-heading p, .key-row p { margin: 0; font-size: .72rem; opacity: .55; }
	.empty { text-align: center; opacity: .5; font-size: .8rem; padding: 1rem 0 .25rem; }
	.image-list { list-style: none; padding: 0; margin: .75rem 0 0; display: grid; gap: .65rem; }
	.image-list li { padding: .65rem; border-radius: .7rem; background: rgba(128,128,128,.07); }
	.image-list strong, .image-list span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.image-list strong { font-size: .78rem; }
	.image-list span { font-size: .64rem; opacity: .5; margin: .15rem 0 .55rem; font-family: ui-monospace, monospace; }
	.image-actions button { padding: .3rem .5rem; border-radius: .45rem; background: rgba(128,128,128,.12); color: inherit; font-size: .7rem; }
	.image-actions button:hover, .image-actions .chosen { background: var(--primary); color: white; }
	.image-actions .danger:hover { background: #dc3545; }
	.checks label { display: flex; align-items: center; gap: .35rem; margin: 0; padding: .45rem .6rem; background: rgba(128,128,128,.08); border-radius: .55rem; }
	.checks input { width: auto; }
	details { margin-bottom: .75rem; border-top: 1px dashed var(--line-divider, rgba(128,128,128,.2)); padding-top: .7rem; }
	summary { cursor: pointer; font-size: .78rem; font-weight: 700; margin-bottom: .65rem; }
	.publish { width: 100%; margin-top: 1rem; padding: .85rem 1rem; border-radius: .8rem; color: white; background: var(--primary); font-weight: 800; box-shadow: 0 8px 24px color-mix(in srgb, var(--primary) 25%, transparent); }
	.publish:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }
	.status, .error-message { font-size: .76rem; line-height: 1.5; margin: .7rem 0 0; padding: .65rem; border-radius: .55rem; }
	.status { background: color-mix(in srgb, var(--primary) 10%, transparent); }
	.error-message { background: rgba(220,53,69,.12); color: #d83a4d; }
	.commit-link { display: inline-block; margin-top: .65rem; color: var(--primary); font-size: .78rem; font-weight: 700; }
	.notice { display: grid; gap: .25rem; padding: .8rem 1rem; border-radius: .8rem; margin-bottom: 1rem; font-size: .8rem; }
	.error-notice { background: rgba(220,53,69,.12); color: #d83a4d; }
	.preview { min-height: 43rem; padding: 1rem 1.25rem; overflow: auto; }
	.markdown-body :global(h1), .markdown-body :global(h2), .markdown-body :global(h3) { margin: 1.2em 0 .55em; font-weight: 800; }
	.markdown-body :global(p) { line-height: 1.8; margin: .8em 0; }
	.markdown-body :global(pre) { overflow: auto; padding: 1rem; border-radius: .75rem; background: rgba(20,20,20,.92); color: #eee; }
	.markdown-body :global(code) { font-family: ui-monospace, monospace; }
	.markdown-body :global(img) { max-width: 100%; border-radius: .75rem; }
	.markdown-body :global(blockquote) { border-left: 3px solid var(--primary); margin-left: 0; padding-left: 1rem; opacity: .75; }

	@media (max-width: 960px) {
		.editor-grid { grid-template-columns: 1fr; }
		.main-editor { min-height: 38rem; }
		.body-label textarea, .preview { min-height: 32rem; }
	}
	@media (max-width: 640px) {
		.topbar { align-items: stretch; flex-direction: column; }
		.top-actions { display: grid; grid-template-columns: 1fr 1fr; }
		.field-row { display: grid; gap: 0; }
		.editor-card { padding: .8rem; }
	}
</style>
