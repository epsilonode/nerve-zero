import React, { useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hljs } from '@/lib/highlight';
import { sanitizeHtml } from '@/lib/sanitize';
import { escapeRegex } from '@/lib/constants';
import { CodeBlockActions } from './CodeBlockActions';
import { renderInlinePathReferences } from './inlineReferences';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  searchQuery?: string;
  suppressImages?: boolean;
  currentDocumentPath?: string;
  onOpenWorkspacePath?: (path: string, basePath?: string) => void | Promise<void>;
  pathLinkPrefixes?: string[];
}

function slugifyHeadingText(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'section';
}

function collectText(children: React.ReactNode): string {
  let result = '';

  React.Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      result += String(child);
      return;
    }

    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
      result += collectText(child.props.children);
    }
  });

  return result;
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;

  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  const parts = text.split(regex);

  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="search-highlight">{part}</mark>
    ) : part,
  );
}

function processChildren(
  children: React.ReactNode,
  options: {
    searchQuery?: string;
    pathLinkPrefixes?: string[];
    onOpenWorkspacePath?: (path: string) => void | Promise<void>;
  } = {},
): React.ReactNode {
  const { searchQuery, pathLinkPrefixes, onOpenWorkspacePath } = options;
  const renderPlainText = (text: string) => highlightText(text, searchQuery ?? '');

  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return renderInlinePathReferences(child, {
        prefixes: pathLinkPrefixes,
        onOpenPath: onOpenWorkspacePath,
        renderPlainText,
      });
    }

    if (React.isValidElement<{ children?: React.ReactNode; node?: { tagName?: string } }>(child)) {
      const tagName = typeof child.type === 'string' ? child.type : '';
      const markdownTagName = child.props.node?.tagName ?? '';
      if (tagName === 'code' || tagName === 'pre' || tagName === 'a' || markdownTagName === 'code' || markdownTagName === 'pre' || markdownTagName === 'a') {
        return child;
      }

      if (child.props.children) {
        return React.cloneElement(child, {
          children: processChildren(child.props.children, options),
        });
      }
    }

    return child;
  });
}

function isWorkspacePathLink(href: string): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return false;
  if (trimmed.startsWith('//')) return false;
  return true;
}

function decodeWorkspacePathLink(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function normalizeWorkspaceLinkTarget(href: string): string {
  const decoded = decodeWorkspacePathLink(href).trim();
  if (!decoded) return decoded;

  if (decoded.startsWith('/')) {
    return decoded.replace(/^\/+/, '');
  }

  return decoded;
}

function CodeBlock({ code, language, highlightedHtml }: {
  code: string;
  language: string;
  highlightedHtml?: string;
}) {
  return (
    <div className="code-block-wrapper">
      <CodeBlockActions code={code} language={language} />
      <pre className="hljs">
        <span className="code-lang">{language}</span>
        {highlightedHtml
          ? <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          : <code>{code}</code>
        }
      </pre>
    </div>
  );
}

/** Render markdown content with syntax highlighting, search highlighting, inline path refs, and in-doc anchors. */
export function MarkdownRenderer({
  content,
  className = '',
  searchQuery,
  suppressImages,
  currentDocumentPath,
  onOpenWorkspacePath,
  pathLinkPrefixes,
}: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const childOptions = useMemo(() => ({
    searchQuery,
    pathLinkPrefixes,
    onOpenWorkspacePath: onOpenWorkspacePath
      ? (path: string) => onOpenWorkspacePath(path)
      : undefined,
  }), [searchQuery, pathLinkPrefixes, onOpenWorkspacePath]);

  const scrollToAnchor = useCallback((href: string) => {
    const rawAnchor = href.replace(/^#/, '').trim();
    if (!rawAnchor) return;

    const anchorId = decodeWorkspacePathLink(rawAnchor);
    const root = containerRef.current;
    if (!root) return;

    const escapedAnchorId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(anchorId)
      : anchorId.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, '\\$1');

    const target = root.querySelector<HTMLElement>(`#${escapedAnchorId}, a[name="${escapedAnchorId}"]`);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState(null, '', `#${anchorId}`);
    }
  }, []);

  const components = useMemo(() => {
    const headingSlugCounts = new Map<string, number>();
    const buildHeadingId = (children: React.ReactNode) => {
      const baseSlug = slugifyHeadingText(collectText(children));
      const seenCount = headingSlugCounts.get(baseSlug) ?? 0;
      headingSlugCounts.set(baseSlug, seenCount + 1);
      return seenCount === 0 ? baseSlug : `${baseSlug}-${seenCount}`;
    };

    const createHeading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
      ({ children }: { children?: React.ReactNode }) => {
        const id = buildHeadingId(children);
        return <Tag id={id}>{processChildren(children, childOptions)}</Tag>;
      };

    return {
      h1: createHeading('h1'),
      h2: createHeading('h2'),
      h3: createHeading('h3'),
      h4: createHeading('h4'),
      h5: createHeading('h5'),
      h6: createHeading('h6'),
      p: ({ children }: { children?: React.ReactNode }) => (
        <p>{processChildren(children, childOptions)}</p>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <li>{processChildren(children, childOptions)}</li>
      ),
      td: ({ children }: { children?: React.ReactNode }) => (
        <td>{processChildren(children, childOptions)}</td>
      ),
      th: ({ children }: { children?: React.ReactNode }) => (
        <th>{processChildren(children, childOptions)}</th>
      ),
      code: ({ className: codeClassName, children, ...props }: { className?: string; children?: React.ReactNode }) => {
        const match = /language-(\w+)/.exec(codeClassName || '');
        const lang = match ? match[1] : '';
        const codeString = String(children).replace(/\n$/, '');
        const inline = !codeClassName;

        if (!inline && lang) {
          try {
            const highlighted = hljs.getLanguage(lang)
              ? hljs.highlight(codeString, { language: lang }).value
              : hljs.highlightAuto(codeString).value;

            return (
              <CodeBlock
                code={codeString}
                language={lang}
                highlightedHtml={sanitizeHtml(highlighted)}
              />
            );
          } catch {
            return <CodeBlock code={codeString} language={lang} />;
          }
        }

        return (
          <code className={codeClassName} {...props}>
            {children}
          </code>
        );
      },
      table: ({ children }: { children?: React.ReactNode }) => (
        <div className="table-wrapper">
          <table className="markdown-table">{children}</table>
        </div>
      ),
      a: ({ children, href }: { children?: React.ReactNode; href?: string }) => {
        if (!href) {
          return <span>{children}</span>;
        }

        if (href.trim().startsWith('#')) {
          return (
            <a
              href={href}
              className="markdown-link"
              onClick={(event) => {
                event.preventDefault();
                scrollToAnchor(href);
              }}
            >
              {children}
            </a>
          );
        }

        if (onOpenWorkspacePath && isWorkspacePathLink(href)) {
          const normalizedTarget = normalizeWorkspaceLinkTarget(href);
          return (
            <a
              href={href}
              className="markdown-link"
              onClick={(event) => {
                event.preventDefault();
                Promise.resolve(onOpenWorkspacePath(normalizedTarget, currentDocumentPath)).catch((error) => {
                  console.error('Failed to open workspace path link:', error);
                });
              }}
            >
              {children}
            </a>
          );
        }

        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="markdown-link">
            {children}
          </a>
        );
      },
      ...(suppressImages ? { img: () => null } : {}),
    };
  }, [childOptions, currentDocumentPath, onOpenWorkspacePath, scrollToAnchor, suppressImages]);

  return (
    <div ref={containerRef} className={`markdown-content ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
