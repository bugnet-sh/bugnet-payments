import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TestPki {
    ca: string;
    serverCert: string;
    serverKey: string;
    clientCert: string;
    clientKey: string;
    otherClientCert: string;
    otherClientKey: string;
}

// Written for OpenSSL 3 and the LibreSSL of macOS alike: extensions come from files, keys from
// ecparam, and nothing prints a key
export function makeTestPki(dir: string, o: { days?: number } = {}): TestPki {
    const days = o.days ?? 365;
    const at = (name: string) => join(dir, name);
    const openssl = (...args: string[]) => {
        execFileSync("openssl", args, { stdio: "pipe" });
    };
    const key = (n: string) => {
        openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", at(`${n}.sec1`));
        openssl("pkcs8", "-topk8", "-nocrypt", "-in", at(`${n}.sec1`), "-out", at(`${n}.key`));
    };
    for (const n of ["ca", "server", "client", "other"]) key(n);

    writeFileSync(
        at("ca.ext"),
        "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
    );
    openssl(
        "req",
        "-new",
        "-key",
        at("ca.key"),
        "-subj",
        "/CN=bugnet-test-ca",
        "-out",
        at("ca.csr"),
    );
    openssl(
        ...["x509", "-req", "-in", at("ca.csr"), "-signkey", at("ca.key")],
        ...["-days", "3650", "-extfile", at("ca.ext"), "-out", at("ca.pem")],
    );

    const leaf = (n: string, name: string, usage: string, serial: number) => {
        writeFileSync(at(`${n}.ext`), `subjectAltName=DNS:${name}\nextendedKeyUsage=${usage}\n`);
        openssl(
            "req",
            "-new",
            "-key",
            at(`${n}.key`),
            "-subj",
            `/CN=${name}`,
            "-out",
            at(`${n}.csr`),
        );
        openssl(
            ...["x509", "-req", "-in", at(`${n}.csr`), "-CA", at("ca.pem"), "-CAkey", at("ca.key")],
            ...["-set_serial", String(serial), "-days", String(days)],
            ...["-extfile", at(`${n}.ext`), "-out", at(`${n}.pem`)],
        );
    };
    leaf("server", "bugnet-payments.internal", "serverAuth", 2);
    leaf("client", "bugnet-egress.internal", "clientAuth", 3);
    leaf("other", "bugnet-other.internal", "clientAuth", 4);

    return {
        ca: at("ca.pem"),
        serverCert: at("server.pem"),
        serverKey: at("server.key"),
        clientCert: at("client.pem"),
        clientKey: at("client.key"),
        otherClientCert: at("other.pem"),
        otherClientKey: at("other.key"),
    };
}
