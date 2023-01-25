import * as dotenv from "dotenv";
dotenv.config();

export const INDEXER_ENDPOINT = "http://localhost:3000";

export const ACCOUNTS = {
    HhuYrWaBKfqB4HbEVdLUHWEPM6TE7cSe9tQsf8reRuvN4vk: {
        name: "Spheres",
        token: process.env.ACCESS_TOKEN_SPHERES,
    },

    HCY3a7emrkNW3SwS7CBpMG5ChTUD5tmGK7u7UAHWAefByGH: {
        name: "Berg und Tal",
        token: process.env.ACCESS_TOKEN_BERG_UND_TAL,
    },
    EdETAjTHQyNcjhVQ4UU4FPP1zowhCqp7J6TLxg72YJbK6Ys: {
        name: "Kineo Circular",
        token: process.env.ACCESS_TOKEN_KINEO_CIRCULAR,
    },
    GhCpYrEdwY38nz263s9siSrZgB2EZkPyQ68SGJqhzj4sP7Z: {
        name: "Ingo Giezendanner",
        token: process.env.ACCESS_TOKEN_INGO_GIEZENDANNER,
    },
    DYV4wcmBUAM3d5qw2svQM7CC5Y5MSR4ED9Zo5JjBP1kGBg5: {
        name: "Eidberg Honig",
        token: process.env.ACCESS_TOKEN_EIDBERG_HONIG,
    },
};

export const CIDS = {
    u0qj944rhWE: {
        cidDecoded: { geohash: "u0qj9", digest: "0x77f79df7" },
        name: "LEU Zürich",
    },
};
