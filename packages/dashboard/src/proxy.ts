/**
 * Runs before every page: the optional password (lib/basic-auth.ts).
 *
 * With `DASHBOARD_PASSWORD` unset this passes everything through, so local
 * development is unchanged. Static assets are excluded by the matcher: they
 * are the app's own JavaScript and CSS and carry no data, and the browser
 * needs them to render the password prompt's retry at all.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "./lib/basic-auth";

export function proxy(request: NextRequest) {
  const password = process.env["DASHBOARD_PASSWORD"]?.trim();
  if (!password) return NextResponse.next();
  if (isAuthorized(request.headers.get("authorization"), password)) return NextResponse.next();

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Observability Agent", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
