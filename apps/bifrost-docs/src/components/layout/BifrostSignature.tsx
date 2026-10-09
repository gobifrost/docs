import { BifrostMark } from "./BifrostMark";

export function BifrostSignature({ markSize = 42, product = "Docs" }: { markSize?: number; product?: string }) {
  return (
    <>
      <BifrostMark className="docs-shell__brand-mark" size={markSize} />
      <span className="brand-signature__copy"><strong>Bifrost</strong><small>{product}</small></span>
    </>
  );
}
