import { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import katex from 'katex';

interface MessageContentProps {
  content: string;
}

/**
 * Component that renders message content with LaTeX math support
 * Supports both inline math ($...$) and display math ($$...$$)
 */
export function MessageContent({ content }: MessageContentProps) {
  const renderedContent = useMemo(() => {
    const parts: JSX.Element[] = [];
    let lastIndex = 0;
    let key = 0;

    // First, handle display math ($$...$$)
    const displayMathRegex = /\$\$([\s\S]*?)\$\$/g;
    const inlineMathRegex = /\$([^\$\n]+?)\$/g;

    // Split by display math first
    let match;
    let tempContent = content;
    const displayMathBlocks: { index: number; length: number; latex: string }[] = [];

    while ((match = displayMathRegex.exec(content)) !== null) {
      displayMathBlocks.push({
        index: match.index,
        length: match[0].length,
        latex: match[1],
      });
    }

    // Process content with both display and inline math
    let currentIndex = 0;
    for (const block of displayMathBlocks) {
      // Process text before display math
      if (currentIndex < block.index) {
        const textBefore = content.substring(currentIndex, block.index);
        processInlineMath(textBefore);
      }

      // Render display math
      try {
        const html = katex.renderToString(block.latex, {
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
        parts.push(<div key={key++}>$$${block.latex}$$</div>);
      }

      currentIndex = block.index + block.length;
    }

    // Process remaining text
    if (currentIndex < content.length) {
      const remaining = content.substring(currentIndex);
      processInlineMath(remaining);
    }

    function processInlineMath(text: string) {
      let lastIdx = 0;
      let inlineMatch;
      const inlineRegex = /\$([^\$\n]+?)\$/g;

      while ((inlineMatch = inlineRegex.exec(text)) !== null) {
        // Text before math
        if (lastIdx < inlineMatch.index) {
          const textPart = text.substring(lastIdx, inlineMatch.index);
          if (textPart) {
            // Split by newlines to preserve them
            textPart.split('\n').forEach((line, idx, arr) => {
              parts.push(<span key={key++}>{line}</span>);
              if (idx < arr.length - 1) {
                parts.push(<br key={key++} />);
              }
            });
          }
        }

        // Inline math
        try {
          const html = katex.renderToString(inlineMatch[1], {
            displayMode: false,
            throwOnError: false,
            strict: false,
          });
          parts.push(
            <span
              key={key++}
              dangerouslySetInnerHTML={{ __html: html }}
              style={{ display: 'inline-block' }}
            />
          );
        } catch (error) {
          parts.push(<span key={key++}>${inlineMatch[1]}$</span>);
        }

        lastIdx = inlineMatch.index + inlineMatch[0].length;
      }

      // Remaining text
      if (lastIdx < text.length) {
        const remaining = text.substring(lastIdx);
        if (remaining) {
          remaining.split('\n').forEach((line, idx, arr) => {
            parts.push(<span key={key++}>{line}</span>);
            if (idx < arr.length - 1) {
              parts.push(<br key={key++} />);
            }
          });
        }
      }
    }

    return parts.length > 0 ? parts : <span>{content}</span>;
  }, [content]);

  return <>{renderedContent}</>;
}
