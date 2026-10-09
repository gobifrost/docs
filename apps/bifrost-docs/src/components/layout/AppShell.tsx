import { useEffect, useState } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { DocsOrganizationsProvider, type DocsOrganizationViewer } from "./useDocsOrganizations";
import "./AppShell.css";

export function AppShell({ children, isAdmin, viewer }: { children: React.ReactNode; isAdmin: boolean; viewer?: DocsOrganizationViewer | null }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <DocsOrganizationsProvider viewer={viewer}>
      <div className="docs-shell" data-density="compact">
        <Sidebar
          isMobileMenuOpen={isMobileMenuOpen}
          setIsMobileMenuOpen={setIsMobileMenuOpen}
          isAdmin={isAdmin}
          onSearchClick={() => setSearchOpen(true)}
        />
        <Header onMobileMenuToggle={() => setIsMobileMenuOpen(true)} searchOpen={searchOpen} onSearchOpenChange={setSearchOpen} />
        <main className="docs-shell__main">{children}</main>
      </div>
    </DocsOrganizationsProvider>
  );
}
