import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { linkButton, PublicLayout } from "../components/PublicLayout";

export function NotFoundContent() {
  const { t } = useTranslation();
  return (
    <div className="py-16 text-center space-y-4">
      <p className="text-5xl font-semibold text-muted-foreground">404</p>
      <p className="text-muted-foreground">{t("notFound.message")}</p>
      <Link to="/" className={linkButton("outline")}>
        {t("notFound.home")}
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <PublicLayout>
      <div className="mx-auto max-w-3xl px-4">
        <NotFoundContent />
      </div>
    </PublicLayout>
  );
}
