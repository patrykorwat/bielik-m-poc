import { useMemo } from 'react';
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
      // First, normalize LaTeX delimiters: convert \[...\] to $$...$$ and \(...\) to $...$
      let normalized = textContent;

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

      // More robust approach: parse character by character to find math delimiters
      const segments: Array<{ type: 'text' | 'inline-math' | 'display-math'; content: string }> = [];

      let i = 0;
      while (i < normalized.length) {
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

      // Render segments
      for (const segment of segments) {
        if (segment.type === 'text') {
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
  }, [content]);

  if (renderedContent === null) {
    return null;
  }

  return <>{renderedContent}</>;
}
