// Shared with the Node preloader, which runs before TypeScript/Next is loaded.
export {
  ADMIN_TOKEN_COOKIE,
  presentedAdminCookie,
  requestHasValidAdminHeader,
  requestHasValidAdminToken,
} from "./admin-auth.cjs";
