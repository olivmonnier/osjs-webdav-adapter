/*
 * OS.js - JavaScript Cloud/Web Desktop Platform
 *
 * Copyright (c) 2011-2020, Anders Evenrud <andersevenrud@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * @author  Anders Evenrud <andersevenrud@gmail.com>
 * @licence Simplified BSD License
 */
const fetch = require("node-fetch");
const { DOMParser } = require("xmldom");

// Removes prefix from a URL
const withoutPrefix = (path) =>
  path.split("/").splice(1).join("/").replace(/^\/?/, "/");

// Gets a WebDAV URL
const davPath = (mount, path) => {
  const { uri } = mount.attributes.connection;
  const prefix = mount.attributes.connection.prefix || "/webdav";
  const suffix = withoutPrefix(path);
  const params = [];

  return uri + prefix + suffix + "?" + params.join("&");
};

// Query base
const queryField = (child, ns, attr, defaultValue) => {
  let value;
  const node = child.getElementsByTagNameNS(ns, attr)[0];
  if (node) {
    value = node.textContent;
  }

  return typeof value === "undefined" ? defaultValue : value;
};

// Queries
const queryFileId = (child, ns) => queryField(child, ns, "getetag");
const queryFileSize = (child, ns) =>
  queryField(child, ns, "getcontentlength", 0);
const queryFileType = (child, ns) =>
  queryField(child, ns, "getcontenttype", "application/octet-stream");
const queryFilePath = (child, ns) =>
  decodeURIComponent(queryField(child, ns, "href", ""));

// Transforms a WebDAV PROPFIND result
const transformReaddir = (mount, root) => (response) => {
  const ns = mount.attributes.connection.ns || "DAV:";
  const dir = root.split(":").slice(-1)[0];
  const childNodes = response.getElementsByTagNameNS(ns, "response");
  let prefix = (mount.attributes.connection.prefix || "/webdav") + dir;

  prefix = prefix.replace(/\/\//g, "/");

  return Array.from(childNodes)
    .map((child) => {
      const path = queryFilePath(child, ns);
      const isDirectory = !!path.match(/\/$/);
      const filename = path
        .substr(prefix.length, path.length)
        .replace(/\/$/, "");

      return { child, path, filename, isDirectory };
    })
    .filter(({ filename }) => filename !== "")
    .filter(({ path }) => {
      const pathWithoutPrefix = path.substr(prefix.length, path.length);
      const count = pathWithoutPrefix.split("/").filter(Boolean).length;

      return count === 1;
    })
    .map(({ child, filename, isDirectory }) => {
      return {
        isDirectory,
        isFile: !isDirectory,
        id: queryFileId(child, ns),
        size: parseInt(queryFileSize(child, ns), 10),
        mime: isDirectory ? null : queryFileType(child, ns),
        path: (root + (root.slice(-1) !== "/" ? "/" : "") + filename).replace(
          /\/\//g,
          "/"
        ),
        filename: filename.replace(/^\//, ""),
        stat: {},
      };
    });
};

// Gets authorization header value
const getAuthorization = (mount) => {
  const { username, password, access_token } = mount.attributes.connection;
  return access_token
    ? `Bearer ${access_token}`
    : "Basic " + new Buffer(`${username}:${password}`).toString("base64");
};

// Creates a XML parser
const createXmlParser = (body) => {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(body, "application/xml");

    return doc;
  } catch (e) {
    console.warn(e);
  }

  return true;
};

// Creates a server request
const request = (method, url, options, mount, binary) => {
  Object.assign(options, {
    method,
    headers: {},
  });

  Object.assign(options.headers, {
    Authorization: getAuthorization(mount),
  });

  const newUrl = new URL(url);
  newUrl.pathname = newUrl.pathname.replace(/\/\//g, "/");

  const result = fetch(newUrl.href, options);

  return binary
    ? result
    : result.then((response) => response.text()).then(createXmlParser);
};

// Makes sure we can make a request with what we have
const before = (mount) => {
  return mount.attributes.connection && mount.attributes.connection.uri
    ? Promise.resolve(true)
    : Promise.reject(new Error("Missing configuration from webdav mountpoint"));
};

// Our adapter
const adapter = (core) => {
  const readfile = (vfs) => (file, options) =>
    before(vfs.mount)
      .then(() => request("GET", davPath(vfs.mount, file), {}, vfs.mount, true))
      .then((response) => response.body);

  const writefile = (vfs) => (file, binary, options) =>
    before(vfs.mount).then(() =>
      request(
        "PUT",
        davPath(vfs.mount, file),
        {
          body: binary,
        },
        vfs.mount
      )
    );

  const unlink = (vfs) => (file, options) =>
    before(vfs.mount).then(() =>
      request("DELETE", davPath(vfs.mount, file), {}, vfs.mount)
    );

  const copy = (vfs) => (src, dest, options) =>
    before(vfs.mount).then(() =>
      request(
        "COPY",
        davPath(vfs.mount, src),
        {
          headers: {
            Destination: davPath(vfs.mount, dest),
          },
        },
        vfs.mount
      )
    );

  const rename = (vfs) => (src, dest, options) =>
    before(vfs.mount).then(() =>
      request(
        "MOVE",
        davPath(vfs.mount, src),
        {
          headers: {
            Destination: davPath(vfs.mount, dest),
          },
        },
        vfs.mount
      )
    );

  const exists = (vfs) => (file, options) =>
    before(vfs.mount)
      .then(() => request("PROPFIND", davPath(vfs.mount, file), {}, vfs.mount))
      .then(() => true);

  const mkdir = (vfs) => (file, options) =>
    before(vfs.mount).then(() => request("KMCOL", davPath(vfs.mount, file)));

  const readdir = (vfs) => (root, options) => {
    return before(vfs.mount).then(() =>
      request("PROPFIND", davPath(vfs.mount, root), {}, vfs.mount).then(
        transformReaddir(vfs.mount, root)
      )
    );
  };

  return { readfile, writefile, unlink, copy, rename, exists, mkdir, readdir };
};

module.exports = adapter;
