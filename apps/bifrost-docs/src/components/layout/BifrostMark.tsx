import logoSquareUrl from "./logo-square.svg?inline";

interface BifrostMarkProps {
  size?: number;
  className?: string;
}

export function BifrostMark({ size = 32, className }: BifrostMarkProps) {
  return <img className={className} src={logoSquareUrl} width={size} height={size} alt="Bifrost" />;
}
