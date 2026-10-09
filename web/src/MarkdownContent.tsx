import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: label, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">{label}</a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
