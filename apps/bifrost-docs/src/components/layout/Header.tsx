import { BifrostHeader } from "bifrost";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchDialog } from "./SearchDialog";
import { OrgSelector } from "./OrgSelector";

export function Header({
  onMobileMenuToggle,
  searchOpen,
  onSearchOpenChange,
}: {
  onMobileMenuToggle: () => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <BifrostHeader
        className="docs-shell__header"
        title="Docs"
        logo={null}
        action={(
          <div className="docs-shell__header-action">
            <Button variant="ghost" size="icon" className="docs-shell__menu-button" onClick={onMobileMenuToggle} aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </Button>
            <OrgSelector />
          </div>
        )}
      />
      <SearchDialog open={searchOpen} onOpenChange={onSearchOpenChange} />
    </>
  );
}
