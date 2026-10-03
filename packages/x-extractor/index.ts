import type { PostExtractor, SourcePost } from '../shared-types/index.ts';

/**
 * X（旧Twitter）のDOMに依存するセレクタは、すべてこの定数に集約する。
 * X側のページ構造が変わった場合は、まずここを確認すること（docs/x-extractor.md 参照）。
 */
export const X_SELECTORS = {
  /** 投稿1件を表す要素 */
  post: 'article[data-testid="tweet"]',
  /** 表示名と @ユーザーID を含むブロック */
  userName: '[data-testid="User-Name"]',
  /** 投稿本文 */
  postText: '[data-testid="tweetText"]',
  /** 投稿日時。親の <a> が投稿への固定リンクになっている */
  timestamp: 'time',
  /** 投稿への固定リンク */
  permalink: 'a[href*="/status/"]',
  /** 引用投稿の枠（この中の本文・ユーザー名は取得対象にしない）。通常のリンクは <a role="link"> なので div に限定する */
  quotedPost: 'div[role="link"]',
} as const;

const STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/;

export class ExtractionError extends Error {}

/** 絵文字は <img alt="🌙"> として埋め込まれているため、alt を文字として拾う。 */
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (el.tagName === 'IMG') return el.getAttribute('alt') ?? '';
  let text = '';
  for (const child of Array.from(el.childNodes)) text += textOf(child);
  return text;
}

function parseStatusUrl(href: string, base: string): { url: string; userId: string; postId: string } | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  const match = STATUS_PATH.exec(url.pathname);
  if (!match) return null;
  return { url: `https://x.com/${match[1]}/status/${match[2]}`, userId: match[1], postId: match[2] };
}

/**
 * X上に表示されている投稿から SourcePost を取り出す（仕様 §8）。
 * 取得するのは 表示名・ユーザーID・本文・URL・投稿ID のみで、
 * Cookieや認証情報、プロフィール等の付随情報には一切触れない。
 */
export class XPostExtractor implements PostExtractor {
  constructor(
    private readonly root: ParentNode,
    private readonly pageUrl: string,
  ) {}

  /** 取得対象の投稿要素を特定する。投稿詳細ページでは、URLの投稿IDと一致するものを選ぶ。 */
  findPostElement(): Element | null {
    const posts = Array.from(this.root.querySelectorAll(X_SELECTORS.post));
    if (posts.length === 0) return null;
    const page = parseStatusUrl(this.pageUrl, this.pageUrl);
    if (!page) return null;
    return posts.find((post) => this.getPostId(post) === page.postId) ?? null;
  }

  private isInsideQuote(el: Element, post: Element): boolean {
    const quote = el.closest(X_SELECTORS.quotedPost);
    return quote !== null && quote !== post && post.contains(quote);
  }

  private own(post: Element, selector: string): Element | null {
    return Array.from(post.querySelectorAll(selector)).find((el) => !this.isInsideQuote(el, post)) ?? null;
  }

  private permalink(post: Element): ReturnType<typeof parseStatusUrl> {
    const time = this.own(post, X_SELECTORS.timestamp);
    const href = time?.closest('a')?.getAttribute('href');
    const fromTime = href ? parseStatusUrl(href, this.pageUrl) : null;
    if (fromTime) return fromTime;
    for (const link of Array.from(post.querySelectorAll(X_SELECTORS.permalink))) {
      if (this.isInsideQuote(link, post)) continue;
      const parsed = parseStatusUrl(link.getAttribute('href') ?? '', this.pageUrl);
      if (parsed) return parsed;
    }
    return null;
  }

  getPostUrl(post: Element): string | undefined {
    return this.permalink(post)?.url;
  }

  getPostId(post: Element): string | undefined {
    return this.permalink(post)?.postId;
  }

  getDisplayName(post: Element): string {
    const block = this.own(post, X_SELECTORS.userName);
    if (!block) return '';
    // 最初のリンク（またはブロック先頭の要素）が表示名、以降が @ユーザーID・日時
    const first = block.querySelector('a') ?? block.firstElementChild;
    const name = first ? textOf(first).trim() : '';
    return name.startsWith('@') ? '' : name;
  }

  getUserId(post: Element): string {
    const block = this.own(post, X_SELECTORS.userName);
    if (block) {
      for (const span of Array.from(block.querySelectorAll('span'))) {
        const text = (span.textContent ?? '').trim();
        if (/^@[A-Za-z0-9_]{1,15}$/.test(text)) return text;
      }
    }
    const fromUrl = this.permalink(post)?.userId;
    return fromUrl ? `@${fromUrl}` : '';
  }

  getPostText(post: Element): string {
    const el = this.own(post, X_SELECTORS.postText);
    return el ? textOf(el).trim() : '';
  }

  extractFrom(post: Element): SourcePost {
    const result: SourcePost = {
      platform: 'x',
      postId: this.getPostId(post),
      postUrl: this.getPostUrl(post),
      userDisplayName: this.getDisplayName(post),
      userId: this.getUserId(post),
      text: this.getPostText(post),
      capturedAt: new Date().toISOString(),
    };
    if (!result.userId && !result.userDisplayName) {
      throw new ExtractionError('投稿者の情報を取得できませんでした。');
    }
    return result;
  }

  async extract(): Promise<SourcePost> {
    const post = this.findPostElement();
    if (!post) {
      throw new ExtractionError('投稿を特定できませんでした。登録したい投稿の詳細ページを開いてください。');
    }
    return this.extractFrom(post);
  }
}
