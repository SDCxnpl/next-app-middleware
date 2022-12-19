import {
  Branch,
  BranchTypes,
  renderRouter,
  RouterHooksConfig,
} from "@next-app-middleware/runtime/dist/router/ejected";
import { parse } from "@swc/core";
import { watch } from "chokidar";
import { createHash } from "crypto";
import fse from "fs-extra";
import _glob from "glob";
import { join } from "path";
import { format } from "prettier";
import { promisify } from "util";
import { ExternalLayout, LayoutType, SegmentLayout } from "./types";

const { readFile, readdir, stat, outputFile } = fse;
const glob = promisify(_glob);

const defaultHooksConfig: RouterHooksConfig = {
  notFound: false,
  redirect: false,
  rewrite: false,
  json: false,
  params: false,
  response: false,
};

const dynamicSegmentRegex = /\[(.*)\]/;
const isDynamicSegment = (segment: string) => dynamicSegmentRegex.test(segment);

const routeGroupSegmentRegex = /\((.*)\)/;
const isRouteGroupSegment = (segment: string) =>
  routeGroupSegmentRegex.test(segment);

const middlewareRegex = /^(middleware\.(?:t|j)s)$/;
const findMiddleware = (filesAndFolders: string[]) =>
  filesAndFolders.find((fileOrfolder) => middlewareRegex.test(fileOrfolder));

const pageRegex = /^(page\.(?:tsx|jsx?))$/;
const findPage = (filesAndFolders: string[]) =>
  filesAndFolders.find((fileOrfolder) => pageRegex.test(fileOrfolder));

const rewriteRegex = /^(rewrite\.(?:t|j)s)$/;
const findRewrite = (filesAndFolders: string[]) =>
  filesAndFolders.find((fileOrfolder) => rewriteRegex.test(fileOrfolder));

const collectRewrites = async (dir: string, filesAndFolders: string[]) => {
  const rewriteFile = findRewrite(filesAndFolders);
  if (rewriteFile) {
    return await collectModuleExports(join(dir, rewriteFile));
  } else return [];
};

const collectChildren = async (
  dir: string,
  externalPath: string,
  filesAndFolders: string[],
  rewrite: string[],
  getParent: () => SegmentLayout
) => {
  const children: Record<string, SegmentLayout> = {};
  await Promise.all(
    filesAndFolders.map(async (fileOrFolder) => {
      const stats = await stat(join(dir, fileOrFolder));
      if (stats.isDirectory()) {
        if (isRouteGroupSegment(fileOrFolder)) {
          children[fileOrFolder] = await collectLayout(
            join(dir, fileOrFolder),
            externalPath,
            rewrite,
            getParent
          );
        } else {
          const match = dynamicSegmentRegex.exec(fileOrFolder);
          if (match) {
            if (rewrite.includes(match[1])) {
              children[fileOrFolder] = await collectLayout(
                join(dir, fileOrFolder),
                externalPath,
                rewrite,
                getParent
              );
            } else {
              children[fileOrFolder] = await collectLayout(
                join(dir, fileOrFolder),
                join(externalPath, `:${match[1]}`),
                rewrite,
                getParent
              );
            }
          } else {
            children[fileOrFolder] = await collectLayout(
              join(dir, fileOrFolder),
              join(externalPath, fileOrFolder),
              rewrite,
              getParent
            );
          }
        }
      }
    })
  );
  return children;
};

const collectLayout = async (
  dir: string = "app",
  externalPath = "/",
  parentRewrite: string[] = [],
  getParent?: () => SegmentLayout
) => {
  const filesAndFolders = await readdir(dir);
  const [currentSegment] = dir.split("/").reverse();
  const dynamic = dynamicSegmentRegex.exec(currentSegment)?.[1];
  const rewrite = isRouteGroupSegment(currentSegment)
    ? parentRewrite
    : await collectRewrites(dir, filesAndFolders);
  const hash =
    externalPath === "/"
      ? "/"
      : externalPath
          .split("/")
          .map((segment) => (segment.startsWith(":") ? ":" : segment))
          .join("/") + "/";
  const layoutPage = findPage(filesAndFolders);
  const layoutMiddleware = findMiddleware(filesAndFolders);
  const layoutRewrite = findRewrite(filesAndFolders);
  const layout: SegmentLayout = {
    location: dir,
    internalPath:
      dir === "app"
        ? "/"
        : "/" +
          dir
            .replace(/^app\//, "")
            .split("/")
            .map((segment) => {
              if (routeGroupSegmentRegex.test(segment)) return false;
              const match = dynamicSegmentRegex.exec(segment);
              if (!match) return segment;
              else return `:${match[1]}`;
            })
            .filter(Boolean)
            .join("/") +
          "/",
    externalPath: externalPath === "/" ? "/" : externalPath + "/",
    segment: currentSegment,
    group: isRouteGroupSegment(currentSegment),
    hash,
    dynamic,
    rewrite,
    page: !!layoutPage,
    middleware: !!layoutMiddleware,
    files: {
      middleware: layoutMiddleware,
      page: layoutPage,
      rewrite: layoutRewrite,
    },
    hashes: {
      middleware:
        !!layoutMiddleware &&
        createHash("sha1")
          .update(join(dir, "middleware"))
          .digest("hex")
          .slice(0, 12),
      rewrite: isRouteGroupSegment(currentSegment)
        ? {}
        : rewrite.reduce(
            (acc, val) => ({
              ...acc,
              [val]: createHash("sha1")
                .update(join(dir, "rewrite", val))
                .digest("hex")
                .slice(0, 12),
            }),
            {}
          ),
    },
    children: await collectChildren(
      dir,
      externalPath,
      filesAndFolders,
      rewrite,
      () => layout
    ),
    parent: getParent,
  };
  return layout;
};

const collectModuleExports = async (path: string) => {
  const code = await readFile(join(process.cwd(), path), { encoding: "utf8" });
  const ast = await parse(code, {
    syntax: "typescript",
  });
  const exports = [];
  for (const item of ast.body) {
    if (item.type === "ExportDeclaration") {
      const { declaration } = item;
      if (declaration.type === "VariableDeclaration") {
        const { declarations } = declaration;
        for (const variableDeclarator of declarations) {
          if (variableDeclarator.id.type === "Identifier")
            exports.push(variableDeclarator.id.value);
        }
      } else if (declaration.type === "FunctionDeclaration")
        exports.push(declaration.identifier.value);
    } else if (item.type === "ExportNamedDeclaration") {
      for (const specifier of item.specifiers) {
        if (specifier.type === "ExportSpecifier") {
          if (specifier.exported) exports.push(specifier.exported.value);
          else exports.push(specifier.orig.value);
        }
      }
    }
  }
  return exports;
};

const getPages = (layout: SegmentLayout): SegmentLayout[] => {
  const result: SegmentLayout[] = [];
  if (layout.page) result.push(layout);
  for (const child of Object.values(layout.children)) {
    result.push(...getPages(child));
  }
  return result;
};

const getSimilarPages = (pages: SegmentLayout[]) => {
  const result: Record<string, SegmentLayout[]> = {};
  for (const page of pages) {
    if (!result[page.hash]) result[page.hash] = [page];
    else result[page.hash].push(page);
  }
  return result;
};

const getRoute = (page: SegmentLayout): SegmentLayout[] => {
  const result: SegmentLayout[] = [page];
  let getParent = page.parent;
  while (getParent) {
    const parent = getParent();
    result.push(parent);
    getParent = parent.parent;
  }
  return result.reverse();
};

const validateLayout = (externalLayout: ExternalLayout) => {
  for (const pages of Object.values(externalLayout)) {
    const externalPath = pages[0].externalPath;
    for (const page of pages.slice(1)) {
      if (page.externalPath !== externalPath)
        throw new Error(
          `Invalid Configuration: ${pages[0].location} and ${page.location} result in different pages but the same Matcher.`
        );
      const sameInternalPath = pages.find(
        (test) => test !== page && test.internalPath === page.internalPath
      );
      if (sameInternalPath)
        throw new Error(
          `Invalid Configuration: ${sameInternalPath.location} and ${page.location} result in the same external and internal path, but different routing.`
        );
    }
  }
};

type MergedRoute = [
  current: SegmentLayout,
  next?: MergedRoute | SegmentLayout,
  rewrite?: MergedRoute
];

type FlattenedRoute = [
  current: string,
  currentSegment: SegmentLayout,
  type: 0 | string,
  next?: FlattenedRoute | SegmentLayout,
  rewrite?: FlattenedRoute | SegmentLayout
];

const resolveLayouts = (pages: SegmentLayout[]) => {
  const resolved = pages
    .sort(({ location: locationA }, { location: locationB }) => {
      const diff = locationA.split("/").length - locationB.split("/").length;
      if (diff === 0) return locationA.length - locationB.length;
      else return diff;
    })
    .map((layout) => getRoute(layout));
  return resolved;
};

const filterDynamicRoutes =
  (rewrite: string[]) =>
  ([page, ...rest]: SegmentLayout[]) => {
    let current: SegmentLayout | undefined = page;
    while (current && current.group) current = rest.shift();
    if (!current) return false;
    return current.dynamic && rewrite.includes(current.dynamic);
  };

const filterNextRoutes =
  (rewrite: string[]) =>
  ([page, ...rest]: SegmentLayout[]) => {
    let current: SegmentLayout | undefined = page;
    while (current && current.group) current = rest.shift();
    if (!current) return true;
    return !current.dynamic || !rewrite.includes(current.dynamic);
  };

// this assumes that the first page in each collection is the same
const mergeLayouts = (pages: SegmentLayout[][]): MergedRoute => {
  const [[currentPage]] = pages;
  const nextPages = pages.map(([, ...pages]) => pages);
  const hasLast = !!nextPages.find((pages) => pages.length === 0);
  const nexts = nextPages.filter(filterNextRoutes(currentPage.rewrite));
  const rewrites = nextPages.filter(filterDynamicRoutes(currentPage.rewrite));
  if (hasLast && nexts.length > 1) {
    throw new Error("1");
  }
  const next = hasLast
    ? currentPage
    : nexts.length
    ? mergeLayouts(nexts)
    : undefined;
  const rewrite = rewrites.length ? mergeLayouts(rewrites) : undefined;
  return [currentPage, next, rewrite];
};

const getNextDynamicParam = ([current, , rewrite]: MergedRoute): string => {
  if (current.dynamic) return current.dynamic;
  else if (!rewrite) throw new Error("getNextDynamicParam");
  else return getNextDynamicParam(rewrite);
};

const flattenMergedRoute = ([current, next, rewrite]: MergedRoute):
  | FlattenedRoute
  | SegmentLayout
  | undefined => {
  if (current.middleware) {
    if (rewrite) {
      const flattenedRoute: FlattenedRoute = [
        current.hashes.middleware as string,
        current,
        0,
        flattenMergedRoute([{ ...current, middleware: false }, next, rewrite]),
      ];
      return flattenedRoute;
    } else {
      const flattenedRoute: FlattenedRoute = [
        current.hashes.middleware as string,
        current,
        0,
        next instanceof Array ? flattenMergedRoute(next) : next && next,
        rewrite && flattenMergedRoute(rewrite),
      ];
      return flattenedRoute;
    }
  } else if (rewrite) {
    const param = getNextDynamicParam(rewrite);
    const flattenedRoute: FlattenedRoute = [
      current.hashes.rewrite[param],
      current,
      param,
      next instanceof Array ? flattenMergedRoute(next) : next,
      rewrite && flattenMergedRoute(rewrite),
    ];
    return flattenedRoute;
  } else {
    if (next instanceof Array) return flattenMergedRoute(next);
    return next;
  }
};

const traverseRoute = <T>(
  [hash, current, type, next, rewrite]: FlattenedRoute,
  onSegment: (hash: string, segment: SegmentLayout, type: 0 | string) => T
): LayoutType<T> => {
  return [
    onSegment(hash, current, type),
    next instanceof Array ? traverseRoute(next, onSegment) : 1,
    rewrite instanceof Array ? traverseRoute(rewrite, onSegment) : 1,
  ];
};

const generate = async () => {
  const layout = await collectLayout();
  let segmentAmount = 0;
  const pages = getPages(layout);
  pages.forEach((page) => {
    const segments = page.internalPath.split("/").length - 2;
    if (segments > segmentAmount) segmentAmount = segments;
  });
  const hooksPromise = readHooksConfig();
  const publicPromise = collectPublicFiles();
  const externalLayout = getSimilarPages(pages);
  validateLayout(externalLayout);
  const allPaths = new Set<string>();
  const externalPaths = new Set<string>();
  const routes = Object.entries(externalLayout).map(([key, layouts]) => {
    layouts.forEach((layout) => allPaths.add(layout.internalPath));
    layouts.forEach((layout) => externalPaths.add(layout.externalPath));
    const resolvedLayouts = resolveLayouts(layouts);
    const mergedRoutes = mergeLayouts(resolvedLayouts);
    return [key, flattenMergedRoute(mergedRoutes) as FlattenedRoute] as const;
  });
  const imported: Record<string, [string, "rewrite" | "middleware"]> = {};
  const layoutRoutes: Array<[string, LayoutType<string> | 0]> = [];
  routes.forEach(([routeHash, route]) => {
    const replaced = traverseRoute(route, (hash, segment) => {
      if (!imported[hash]) {
        if (hash === segment.hashes.middleware) {
          imported[hash] = [segment.location, "middleware"];
        } else {
          const [rewrite] =
            Object.entries(segment.hashes.rewrite).find(
              ([, rewriteHash]) => rewriteHash === hash
            ) || [];
          if (!rewrite) throw new Error("3");
          imported[hash] = [segment.location, "rewrite"];
        }
      }
      return `segment_${hash}`;
    });
    layoutRoutes.push([routeHash, replaced]);
  });
  const bySegmentAmount: typeof routes[] = [];
  routes.forEach((route) => {
    const segmentAmount = route[0].split("/").length - 2;
    if (!bySegmentAmount[segmentAmount])
      bySegmentAmount[segmentAmount] = [route];
    else bySegmentAmount[segmentAmount].push(route);
  });
  const branches = bySegmentAmount.map((similarRoutes) =>
    toMatcherMap(similarRoutes)
  );
  const ejectedBranches = branches.map((map) => ejectMatcherMap(map));
  return format(
    renderRouter({
      branches: ejectedBranches,
      publicFiles: await publicPromise,
      segmentAmount,
      hooks: await hooksPromise,
      imports: Object.values(imported),
    }),
    { parser: "babel-ts" }
  );
};

const collectMatcherData = (pages: SegmentLayout[]) => {
  const matcherData: Set<string>[] = [];
  for (const page of pages) {
    const [, ...segments] = page.internalPath.split("/");
    for (let i = 0; i < segments.length - 1; i++) {
      if (!matcherData[i]) matcherData[i] = new Set();
      const segment = segments[i];
      if (segment.startsWith(":")) matcherData[i].add(":");
      else matcherData[i].add(segment);
    }
  }
  return matcherData;
};

const collectPublicFiles = async () => {
  return (await glob("public/**/*")).map((path) => path.slice(6));
};

const readHooksConfig = async () => {
  const matches = await glob("./middleware.hooks.{ts,js}");
  if (matches.length === 0)
    return {
      ...defaultHooksConfig,
    };
  if (matches.length > 1)
    console.warn("Multiple middleware configs found, using:", matches[0]);
  const exports = await collectModuleExports(matches[0]);
  const config = {
    ...defaultHooksConfig,
  };
  exports.forEach((key) => {
    if (Object.hasOwn(config, key)) config[key as keyof typeof config] = true;
  });
  return config;
};

type MatcherMap = Map<string, FlattenedRoute | MatcherMap>;

const toMatcherMap = (similarRoutes: (readonly [string, FlattenedRoute])[]) => {
  const map: MatcherMap = new Map();
  for (const [externalPath, route] of similarRoutes) {
    let currentMap = map;
    const segments = externalPath.slice(1, -1).split("/");
    for (const segment of segments.slice(0, -1)) {
      if (!currentMap.has(segment)) currentMap.set(segment, new Map());
      currentMap = currentMap.get(segment) as MatcherMap;
    }
    currentMap.set(segments[segments.length - 1], route);
  }
  return map;
};

const ejectMatcherMap = (
  map: FlattenedRoute | MatcherMap,
  depth = 0
): Branch => {
  if (map instanceof Map) {
    const defaultCase = map.get(":");
    return {
      type: BranchTypes.SWITCH,
      index: depth,
      cases: Array.from(map.entries())
        .filter(([segment]) => segment !== ":")
        .map(([segment, entry]) => {
          return {
            match: segment,
            then: ejectMatcherMap(entry, depth + 1),
          };
        }),
      defaultCase: defaultCase
        ? ejectMatcherMap(defaultCase, depth + 1)
        : {
            type: BranchTypes.NOT_FOUND,
          },
    };
  } else return ejectRoute(map);
};

const ejectPage = (page: SegmentLayout, appliedParams: Set<string>): Branch => {
  const segments = page.externalPath.split("/");
  const [segment] = segments.filter(
    (segment) => segment.startsWith(":") && !appliedParams.has(segment.slice(1))
  );

  if (segment) {
    const name = segment.slice(1);
    const index = segments.indexOf(segment) - 1;
    appliedParams.add(name);
    return {
      type: BranchTypes.DYNAMIC,
      name,
      index,
      then: ejectPage(page, appliedParams),
    };
  }
  return {
    type: BranchTypes.NEXT,
    rewrite: page.internalPath.includes("/:") ? page.internalPath : undefined,
  };
};

const ejectRoute = (
  [currentHash, currentSegment, type, next, rewrite]: FlattenedRoute,
  appliedParams = new Set<string>()
): Branch => {
  const segments = currentSegment.externalPath.split("/");
  const [segment] = segments.filter(
    (segment) => segment.startsWith(":") && !appliedParams.has(segment.slice(1))
  );

  if (segment) {
    const name = segment.slice(1);
    const index = segments.indexOf(segment) - 1;
    appliedParams.add(name);
    return {
      type: BranchTypes.DYNAMIC,
      name,
      index,
      then: ejectRoute(
        [currentHash, currentSegment, type, next, rewrite],
        appliedParams
      ),
    };
  }
  if (typeof type === "number") {
    return {
      type: BranchTypes.MIDDLEWARE,
      id: currentHash,
      internalPath: currentSegment.internalPath,
      location: currentSegment.location,
      then:
        next instanceof Array
          ? ejectRoute(next, appliedParams)
          : next
          ? ejectPage(next, appliedParams)
          : {
              type: BranchTypes.NOT_FOUND,
            },
    };
  } else {
    return {
      type: BranchTypes.REWRITE,
      name: type,
      id: currentHash,
      internalPath: currentSegment.internalPath,
      location: currentSegment.location,
      then:
        next instanceof Array
          ? ejectRoute(next, appliedParams)
          : next
          ? ejectPage(next, appliedParams)
          : {
              type: BranchTypes.NOT_FOUND,
            },
      rewrite:
        rewrite instanceof Array
          ? ejectRoute(rewrite, appliedParams)
          : rewrite
          ? ejectPage(rewrite, appliedParams)
          : {
              type: BranchTypes.NOT_FOUND,
            },
    };
  }
};

class CancelToken {
  public cancelled = false;
  public onCancel?: () => void;
  public cancel() {
    this.cancelled = true;
    this.onCancel && this.onCancel();
  }
}

export const build = async (token?: CancelToken) => {
  const code = await generate();
  if (token && token.cancelled) return;
  await outputFile(join(process.cwd(), "middleware.ts"), code);
  console.info("Successfuly built middleware.");
};

export const dev = async () => {
  const buildWithCatch = async (token?: CancelToken) => {
    try {
      await build(token);
    } catch (e) {
      console.error("Error while building middleware:", e);
    }
  };
  await buildWithCatch();
  console.info("waiting for middleware changes...");
  let cancelToken: CancelToken;
  const runBuild = (type: string) => (file: string) => {
    console.info(`${type} ${file}`);
    if (cancelToken) cancelToken.cancel();
    cancelToken = new CancelToken();
    buildWithCatch(cancelToken);
  };

  watch("app/**/middleware.{ts,js}", { ignoreInitial: true })
    .add("app/**/page.{tsx,js,jsx}")
    .add("public/**/*")
    .on("add", runBuild("added"))
    .on("unlink", runBuild("deleted"));

  watch("app/**/rewrite.{ts,js}", { ignoreInitial: true })
    .add("./middleware.hooks.{ts,js}")
    .on("add", runBuild("added"))
    .on("unlink", runBuild("deleted"))
    .on("change", runBuild("changed"));
};
