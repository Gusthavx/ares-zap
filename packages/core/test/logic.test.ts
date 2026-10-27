import { describe, expect, it } from "vitest";
import {
    containsAnyPhrase, dailyCap, evalCondition, matchKeyword, matchMenuOption, normalizePhone, pickTrigger, pickWeighted,
    renderTemplate, resolveSettings, validateAnswer, validateGraph, zonedParts, zonedToDate, emptyGraph,
    type FlowTrigger,
} from "../src";

describe("texto", () => {
    it("containsAnyPhrase casa palavra inteira e prefixo com *", () => {
        expect(containsAnyPhrase("Quero meu reembolso!", "reembols*")).toBe(true);
        expect(containsAnyPhrase("Foi ótimo", "oi")).toBe(false);
        expect(containsAnyPhrase("oi, tudo bem?", "olá, oi")).toBe(true);
    });
    it("renderTemplate troca variáveis e zera as desconhecidas", () => {
        expect(renderTemplate("Olá {primeiro-nome}{x}!", { "primeiro-nome": "Ana" })).toBe("Olá Ana!");
    });
    it("matchMenuOption aceita número, texto sem acento e id da resposta interativa", () => {
        const opts = [{ id: "a", text: "Sim" }, { id: "b", text: "Não" }];
        expect(matchMenuOption("2)", opts)?.id).toBe("b");
        expect(matchMenuOption("nao", opts)?.id).toBe("b");
        expect(matchMenuOption("", opts, "option:a")?.id).toBe("a");
        expect(matchMenuOption("3", opts)).toBeNull();
    });
    it("matchKeyword: exato, contém, palavra e regex", () => {
        expect(matchKeyword("Olá", "ola")).toBe(true);
        expect(matchKeyword("quero o preço", "preco", "contains")).toBe(true);
        expect(matchKeyword("bom dia", "dia", "word")).toBe(true);
        expect(matchKeyword("pedido 1234", "\\d{4}", "regex")).toBe(true);
        expect(matchKeyword("x", "(", "regex")).toBe(false);
    });
});

describe("validação de respostas", () => {
    it("CPF com dígito verificador", () => {
        expect(validateAnswer("cpf", { text: "529.982.247-25", type: "text" })).toBe("52998224725");
        expect(validateAnswer("cpf", { text: "111.111.111-11", type: "text" })).toBeNull();
    });
    it("data brasileira", () => {
        expect(validateAnswer("date", { text: "31/12/2026", type: "text" })).toBe("2026-12-31");
        expect(validateAnswer("date", { text: "31/02/2026", type: "text" })).toBeNull();
        expect(validateAnswer("datetime", { text: "01/01/2027 08:30", type: "text" })).toBe("2027-01-01 08:30");
    });
    it("número com milhar e vírgula", () => {
        expect(validateAnswer("number", { text: "1.234,56", type: "text" })).toBe("1234.56");
    });
    it("mídia pelo tipo da mensagem", () => {
        expect(validateAnswer("image", { text: "", type: "image", mediaRef: "asset1" })).toBe("asset1");
        expect(validateAnswer("image", { text: "oi", type: "text" })).toBeNull();
    });
});

describe("condições", () => {
    const ctx = { tagIds: ["vip"], weekday: 1, minutes: 9 * 60, today: "2026-10-26", fields: { idade: "30", cidade: "São Paulo" } };
    it("etiqueta, hora, número e texto", () => {
        expect(evalCondition({ id: "1", source: "tag", op: "is", value: "vip" }, ctx)).toBe(true);
        expect(evalCondition({ id: "2", source: "time", op: "before", value: "10:00" }, ctx)).toBe(true);
        expect(evalCondition({ id: "3", source: "field", fieldKey: "idade", fieldType: "NUMBER", op: "gte", value: "18" }, ctx)).toBe(true);
        expect(evalCondition({ id: "4", source: "field", fieldKey: "cidade", op: "contains", value: "sao" }, ctx)).toBe(true);
    });
});

describe("gatilhos", () => {
    const t = (type: FlowTrigger["type"], priority = 0, value?: string): { trigger: FlowTrigger; name: string } =>
        ({ trigger: { id: type + priority, type, value, match: "word", priority }, name: `${type}:${priority}` });
    it("palavra-chave > primeira mensagem > qualquer mensagem, por prioridade", () => {
        const list = [t("anyMessage"), t("firstMessage"), t("keyword", 1, "preço"), t("keyword", 5, "preço")];
        expect(pickTrigger([...list], "qual o preço?", true)?.name).toBe("keyword:5");
        expect(pickTrigger([...list], "oi", true)?.name).toBe("firstMessage:0");
        expect(pickTrigger([...list], "oi", false)?.name).toBe("anyMessage:0");
    });
});

describe("fuso", () => {
    it("zonedToDate e zonedParts ida e volta em São Paulo", () => {
        const d = zonedToDate("2026-10-26T09:30", "America/Sao_Paulo")!;
        expect(d.toISOString()).toBe("2026-10-26T12:30:00.000Z");
        expect(zonedParts(d, "America/Sao_Paulo").hhmm).toBe("09:30");
    });
    it("Nova York respeita horário de verão", () => {
        expect(zonedToDate("2026-07-01T08:00", "America/New_York")!.toISOString()).toBe("2026-07-01T12:00:00.000Z");
        expect(zonedToDate("2026-12-01T08:00", "America/New_York")!.toISOString()).toBe("2026-12-01T13:00:00.000Z");
    });
});

describe("telefone e configurações", () => {
    it("normalizePhone aplica o DDI do Brasil", () => {
        expect(normalizePhone("(11) 99999-8888")).toBe("5511999998888");
        expect(normalizePhone("+1 212 555 0100")).toBe("12125550100");
        expect(normalizePhone("abc")).toBeNull();
    });
    it("configuração padrão e aquecimento", () => {
        const s = resolveSettings({});
        expect(s.timezone).toBe("America/Sao_Paulo");
        expect(s.sending.bulkMinGapSec).toBe(15);
        expect(dailyCap(s, 0)).toBe(50);
        expect(dailyCap(s, 100)).toBe(s.sending.perDay);
    });
    it("pickWeighted respeita o peso", () => {
        const o = [{ id: "a", weight: 90 }, { id: "b", weight: 10 }];
        expect(pickWeighted(o, 0.5)?.id).toBe("a");
        expect(pickWeighted(o, 0.95)?.id).toBe("b");
    });
});

describe("validateGraph", () => {
    it("grafo vazio pede ligação no início", () => {
        expect(validateGraph(emptyGraph()).some(i => i.level === "error")).toBe(true);
    });
});
