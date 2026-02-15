import { useMemo, useState } from 'react';
import 'katex/dist/katex.min.css';
import katex from 'katex';

interface MessageContentProps {
  content: string | any[];
}

/**
 * Component that renders message content with LaTeX math support
 * Supports multiple LaTeX delimiters:
 * - Inline: $...$ or \(...\)
 * - Display: $$...$$ or \[...\]
 */
export function MessageContent({ content }: MessageContentProps) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    });
  };

  const renderedContent = useMemo(() => {
    // If content is an array, process it
    if (Array.isArray(content)) {
      console.log('Content is array:', content);

      // Extract text from Claude content blocks
      const textParts: string[] = [];
      for (const block of content) {
        if (typeof block === 'object' && block !== null) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          }
          // tool_use and tool_result blocks are handled separately in the UI
        }
      }

      // If we found text, process it for LaTeX
      if (textParts.length > 0) {
        const textContent = textParts.join('\n');
        console.log('Extracted text from array:', textContent);
        // Continue to processing below
        return processContent(textContent);
      }

      // Otherwise, check if it's tool_result format (should be hidden)
      const hasToolResults = content.some(
        (block: any) => block.type === 'tool_result'
      );
      if (hasToolResults) {
        return null; // Tool results are displayed separately
      }

      return null;
    }

    // Ensure content is a string
    const textContent = typeof content === 'string' ? content : String(content);

    // Debug: log raw content
    console.log('Raw content:', textContent);

    return processContent(textContent);

    function processContent(textContent: string): JSX.Element[] | JSX.Element {
      // Extract code blocks first (before LaTeX processing)
      const codeBlockRegex = /```(\w+)?\n([\s\S]*?)\n```/g;
      const codeBlocks: Array<{ index: number; language: string; code: string }> = [];
      let match;
      let codeBlockIndex = 0;

      while ((match = codeBlockRegex.exec(textContent)) !== null) {
        codeBlocks.push({
          index: codeBlockIndex++,
          language: match[1] || 'text',
          code: match[2],
        });
      }

      // Replace code blocks with placeholders
      let normalized = textContent.replace(
        codeBlockRegex,
        (_match, _lang, code) => `__CODE_BLOCK_${codeBlocks.findIndex(cb => cb.code === code)}__`
      );

      // Now normalize LaTeX delimiters: convert \[...\] to $$...$$ and \(...\) to $...$

      // Convert display math: \[...\] to $$...$$
      normalized = normalized.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$1$$');

      // Convert inline math: \(...\) to $...$
      normalized = normalized.replace(/\\\((.*?)\\\)/g, '$$$1$$');

      // Convert standalone \boxed{...} to $\boxed{...}$ (if not already in math mode)
      // Need to handle nested braces properly
      {
        let result = '';
        let i = 0;
        while (i < normalized.length) {
          // Look for \boxed{ that is NOT preceded by $
          if (i >= 6 && normalized.substring(i - 6, i) === '\\boxed' && normalized[i] === '{') {
            // Check if preceded by $
            const precedingChar = i >= 7 ? normalized[i - 7] : '';
            if (precedingChar !== '$') {
              // Find matching closing brace
              let depth = 1;
              let j = i + 1;
              while (j < normalized.length && depth > 0) {
                if (normalized[j] === '{') depth++;
                else if (normalized[j] === '}') depth--;
                j++;
              }

              // Extract the boxed content
              const boxedContent = normalized.substring(i + 1, j - 1);

              // Remove the \boxed{ we already processed and add wrapped version
              result = result.substring(0, result.length - 6); // Remove \boxed
              result += `$\\boxed{${boxedContent}}$`;
              i = j;
              continue;
            }
          }
          result += normalized[i];
          i++;
        }
        normalized = result;
      }

      console.log('Normalized content:', normalized);

      const parts: JSX.Element[] = [];
      let key = 0;

      // More robust approach: parse character by character to find math delimiters and code blocks
      const segments: Array<{
        type: 'text' | 'inline-math' | 'display-math' | 'code-block';
        content: string;
        language?: string;
      }> = [];

      let i = 0;
      while (i < normalized.length) {
        // Check for code block placeholder
        const codeBlockMatch = normalized.substring(i).match(/^__CODE_BLOCK_(\d+)__/);
        if (codeBlockMatch) {
          const blockIndex = parseInt(codeBlockMatch[1], 10);
          const codeBlock = codeBlocks[blockIndex];
          if (codeBlock) {
            segments.push({
              type: 'code-block',
              content: codeBlock.code,
              language: codeBlock.language,
            });
          }
          i += codeBlockMatch[0].length;
          continue;
        }

        // Check for display math $$...$$
        if (i < normalized.length - 1 && normalized[i] === '$' && normalized[i + 1] === '$') {
          // Find closing $$
          let end = i + 2;
          let found = false;
          while (end < normalized.length - 1) {
            if (normalized[end] === '$' && normalized[end + 1] === '$') {
              segments.push({
                type: 'display-math',
                content: normalized.substring(i + 2, end),
              });
              i = end + 2;
              found = true;
              break;
            }
            end++;
          }
          if (!found) {
            // Unclosed $$, treat as text
            segments.push({ type: 'text', content: '$$' });
            i += 2;
          }
        }
        // Check for inline math $...$
        else if (normalized[i] === '$') {
          // Find closing $
          let end = i + 1;
          let found = false;
          // Don't match across newlines for inline math
          while (end < normalized.length && normalized[end] !== '\n') {
            if (normalized[end] === '$') {
              const mathContent = normalized.substring(i + 1, end);
              // Ensure it's not empty and doesn't contain another $
              if (mathContent.length > 0 && !mathContent.includes('$')) {
                segments.push({
                  type: 'inline-math',
                  content: mathContent,
                });
                i = end + 1;
                found = true;
                break;
              }
            }
            end++;
          }
          if (!found) {
            // Unclosed $, treat as text
            segments.push({ type: 'text', content: '$' });
            i++;
          }
        }
        // Regular text
        else {
          // Collect text until next $ or end
          let textEnd = i;
          while (textEnd < normalized.length && normalized[textEnd] !== '$') {
            textEnd++;
          }
          if (textEnd > i) {
            segments.push({
              type: 'text',
              content: normalized.substring(i, textEnd),
            });
            i = textEnd;
          } else {
            i++;
          }
        }
      }

      console.log('Parsed segments:', segments);

      // Simple syntax highlighter for Python using React components
      const highlightPython = (code: string): JSX.Element => {
        const lines = code.split('\n');

        const tokenizeLine = (line: string): Array<{ type: string; value: string }> => {
          const tokens: Array<{ type: string; value: string }> = [];
          let i = 0;

          while (i < line.length) {
            // Skip whitespace
            if (/\s/.test(line[i])) {
              const start = i;
              while (i < line.length && /\s/.test(line[i])) i++;
              tokens.push({ type: 'whitespace', value: line.substring(start, i) });
              continue;
            }

            // Comments
            if (line[i] === '#') {
              tokens.push({ type: 'comment', value: line.substring(i) });
              break;
            }

            // Strings
            if (line[i] === '"' || line[i] === "'") {
              const quote = line[i];
              const start = i;
              i++;
              while (i < line.length && line[i] !== quote) {
                if (line[i] === '\\') i++; // Skip escaped characters
                i++;
              }
              i++; // Include closing quote
              tokens.push({ type: 'string', value: line.substring(start, i) });
              continue;
            }

            // Numbers
            if (/\d/.test(line[i])) {
              const start = i;
              while (i < line.length && /[\d.]/.test(line[i])) i++;
              tokens.push({ type: 'number', value: line.substring(start, i) });
              continue;
            }

            // Identifiers and keywords
            if (/[a-zA-Z_]/.test(line[i])) {
              const start = i;
              while (i < line.length && /[a-zA-Z0-9_]/.test(line[i])) i++;
              const word = line.substring(start, i);

              const keywords = ['from', 'import', 'def', 'class', 'if', 'else', 'elif', 'for', 'while',
                               'return', 'try', 'except', 'with', 'as', 'in', 'and', 'or', 'not',
                               'True', 'False', 'None', 'print', 'lambda', 'pass', 'break', 'continue'];

              // Check if next non-whitespace is '('
              let j = i;
              while (j < line.length && /\s/.test(line[j])) j++;
              const isFunction = j < line.length && line[j] === '(';

              if (keywords.includes(word)) {
                tokens.push({ type: 'keyword', value: word });
              } else if (isFunction) {
                tokens.push({ type: 'function', value: word });
              } else {
                tokens.push({ type: 'identifier', value: word });
              }
              continue;
            }

            // Operators and punctuation
            tokens.push({ type: 'operator', value: line[i] });
            i++;
          }

          return tokens;
        };

        return (
          <>
            {lines.map((line, lineIdx) => (
              <div key={lineIdx} style={{ fontFamily: 'monospace', minHeight: '1.5em' }}>
                {tokenizeLine(line).map((token, tokenIdx) => {
                  const style: React.CSSProperties = {};

                  switch (token.type) {
                    case 'keyword':
                      style.color = '#C586C0';
                      break;
                    case 'string':
                      style.color = '#CE9178';
                      break;
                    case 'comment':
                      style.color = '#6A9955';
                      style.fontStyle = 'italic';
                      break;
                    case 'function':
                      style.color = '#DCDCAA';
                      break;
                    case 'number':
                      style.color = '#B5CEA8';
                      break;
                  }

                  return (
                    <span key={tokenIdx} style={style}>
                      {token.value}
                    </span>
                  );
                })}
              </div>
            ))}
          </>
        );
      };

      // Render segments
      for (const segment of segments) {
        if (segment.type === 'code-block') {
          // Render code block with syntax highlighting
          const isPython = segment.language === 'python' || segment.language === 'py';
          const codeBlockKey = key++;
          parts.push(
            <div
              key={codeBlockKey}
              style={{
                backgroundColor: '#1e1e1e',
                color: '#d4d4d4',
                padding: '16px',
                paddingTop: '40px',
                borderRadius: '8px',
                margin: '12px 0',
                overflow: 'auto',
                fontSize: '14px',
                lineHeight: '1.5',
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: '8px',
                  right: '12px',
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                }}
              >
                {segment.language && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#858585',
                      textTransform: 'uppercase',
                      fontWeight: 'bold',
                    }}
                  >
                    {segment.language}
                  </div>
                )}
                <button
                  onClick={() => copyToClipboard(segment.content, codeBlockKey)}
                  style={{
                    backgroundColor: copiedIndex === codeBlockKey ? '#4CAF50' : '#333',
                    color: '#fff',
                    border: 'none',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 'bold',
                    transition: 'background-color 0.2s',
                  }}
                  title="Kopiuj kod"
                >
                  {copiedIndex === codeBlockKey ? '✓ Skopiowano' : '📋 Kopiuj'}
                </button>
              </div>
              {isPython ? (
                highlightPython(segment.content)
              ) : (
                <pre style={{ margin: 0, fontFamily: 'monospace' }}>
                  {segment.content}
                </pre>
              )}
            </div>
          );
        } else if (segment.type === 'text') {
          // Preserve newlines
          segment.content.split('\n').forEach((line, idx, arr) => {
            if (line) {
              parts.push(<span key={key++}>{line}</span>);
            }
            if (idx < arr.length - 1) {
              parts.push(<br key={key++} />);
            }
          });
        } else if (segment.type === 'inline-math') {
          try {
            const html = katex.renderToString(segment.content, {
              displayMode: false,
              throwOnError: false,
              strict: false,
            });
            parts.push(
              <span
                key={key++}
                dangerouslySetInnerHTML={{ __html: html }}
                style={{ display: 'inline-block', margin: '0 2px' }}
              />
            );
          } catch (error) {
            parts.push(<span key={key++} style={{ color: 'red' }}>Error: ${segment.content}$</span>);
          }
        } else if (segment.type === 'display-math') {
          try {
            const html = katex.renderToString(segment.content, {
              displayMode: true,
              throwOnError: false,
              strict: false,
            });
            parts.push(
              <div
                key={key++}
                dangerouslySetInnerHTML={{ __html: html }}
                style={{ margin: '1em 0', textAlign: 'center' }}
              />
            );
          } catch (error) {
            parts.push(<div key={key++} style={{ color: 'red' }}>Error rendering: $${segment.content}$$</div>);
          }
        }
      }

      return parts.length > 0 ? parts : <span>{textContent}</span>;
    }
  }, [content, copiedIndex, copyToClipboard]);

  if (renderedContent === null) {
    return null;
  }

  return <>{renderedContent}</>;
}
