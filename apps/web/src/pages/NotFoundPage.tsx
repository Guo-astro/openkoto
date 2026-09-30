import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { LandingShell } from "../components/landing/LandingChrome";
import { buttonVariants } from "../components/ui/button";

export function NotFoundContent() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5 py-16 text-center">
      <p className="lp-display lp-muted text-6xl">404</p>
      <p className="lp-muted">{t("notFound.message")}</p>
      <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
        {t("notFound.home")}
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <LandingShell>
      <div className="mx-auto max-w-3xl px-5">
        <NotFoundContent />
      </div>
    </LandingShell>
  );
}
