import { PGLiteDatabaseAdapter } from "@elizaos/adapter-pglite";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { QdrantDatabaseAdapter } from "@elizaos/adapter-qdrant";
import { RedisClient } from "@elizaos/adapter-redis";
import { SqliteDatabaseAdapter } from "@elizaos/adapter-sqlite";
import { SupabaseDatabaseAdapter } from "@elizaos/adapter-supabase";
import { AutoClientInterface } from "@elizaos/client-auto";
import { DiscordClientInterface } from "@elizaos/client-discord";
import { InstagramClientInterface } from "@elizaos/client-instagram";
import { TelegramClientInterface } from "@elizaos/client-telegram";
import { TelegramAccountClientInterface } from "@elizaos/client-telegram-account";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import { MongoDBDatabaseAdapter } from "@elizaos/adapter-mongodb";

import { FarcasterClientInterface } from "@elizaos/client-farcaster";
import { DirectClient } from "@elizaos/client-direct";
import {
    AgentRuntime,
    CacheManager,
    CacheStore,
    type Character,
    type Client,
    Clients,
    DbCacheAdapter,
    defaultCharacter,
    elizaLogger,
    FsCacheAdapter,
    type IAgentRuntime,
    type ICacheManager,
    type IDatabaseAdapter,
    type IDatabaseCacheAdapter,
    ModelProviderName,
    parseBooleanFromText,
    settings,
    stringToUuid,
    validateCharacterConfig,
} from "@elizaos/core";

import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import createGoatPlugin from "@elizaos/plugin-goat";

// import { intifacePlugin } from "@elizaos/plugin-intiface";
import {
    advancedTradePlugin,
    coinbaseCommercePlugin,
    coinbaseMassPaymentsPlugin,
    tokenContractPlugin,
    tradePlugin,
    webhookPlugin,
} from "@elizaos/plugin-coinbase";
import { coingeckoPlugin } from "@elizaos/plugin-coingecko";
import { coinmarketcapPlugin } from "@elizaos/plugin-coinmarketcap";
import { evmPlugin } from "@elizaos/plugin-evm";
import { newsPlugin } from "@elizaos/plugin-news";
import { createNodePlugin } from "@elizaos/plugin-node";
import { openWeatherPlugin } from "@elizaos/plugin-open-weather";
import { dexScreenerPlugin } from "@elizaos/plugin-dexscreener";
import { openaiPlugin } from "@elizaos/plugin-openai";
import Database from "better-sqlite3";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import { MongoClient } from "mongodb";

import { newsProvider } from "../providers/newsProvider";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export const wait = (minTime = 1000, maxTime = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

const logFetch = async (url: string, options: any) => {
    elizaLogger.debug(`Fetching ${url}`);
    // Disabled to avoid disclosure of sensitive information such as API keys
    // elizaLogger.debug(JSON.stringify(options, null, 2));
    return fetch(url, options);
};

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(3))
            .option("character", {
                type: "string",
                description: "Path to the character JSON file",
            })
            .option("characters", {
                type: "string",
                description:
                    "Comma separated list of paths to character JSON files",
            })
            .parseSync();
    } catch (error) {
        elizaLogger.error("Error parsing arguments:", error);
        return {};
    }
}

function tryLoadFile(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (e) {
        return null;
    }
}
function mergeCharacters(base: Character, child: Character): Character {
    const mergeObjects = (baseObj: any, childObj: any) => {
        const result: any = {};
        const keys = new Set([
            ...Object.keys(baseObj || {}),
            ...Object.keys(childObj || {}),
        ]);
        keys.forEach((key) => {
            if (
                typeof baseObj[key] === "object" &&
                typeof childObj[key] === "object" &&
                !Array.isArray(baseObj[key]) &&
                !Array.isArray(childObj[key])
            ) {
                result[key] = mergeObjects(baseObj[key], childObj[key]);
            } else if (
                Array.isArray(baseObj[key]) ||
                Array.isArray(childObj[key])
            ) {
                result[key] = [
                    ...(baseObj[key] || []),
                    ...(childObj[key] || []),
                ];
            } else {
                result[key] =
                    childObj[key] !== undefined ? childObj[key] : baseObj[key];
            }
        });
        return result;
    };
    return mergeObjects(base, child);
}
function isAllStrings(arr: unknown[]): boolean {
    return Array.isArray(arr) && arr.every((item) => typeof item === "string");
}

async function loadCharactersFromUrl(url: string): Promise<Character[]> {
    try {
        const response = await fetch(url);
        const responseJson = await response.json();

        let characters: Character[] = [];
        if (Array.isArray(responseJson)) {
            characters = await Promise.all(
                responseJson.map((character) => jsonToCharacter(url, character))
            );
        } else {
            const character = await jsonToCharacter(url, responseJson);
            characters.push(character);
        }
        return characters;
    } catch (e) {
        elizaLogger.error(`Error loading character(s) from ${url}: ${e}`);
        process.exit(1);
    }
}

async function jsonToCharacter(
    filePath: string,
    character: any
): Promise<Character> {
    validateCharacterConfig(character);

    // .id isn't really valid
    const characterId = character.id || character.name;
    const characterPrefix = `CHARACTER.${characterId
        .toUpperCase()
        .replace(/ /g, "_")}.`;
    const characterSettings = Object.entries(process.env)
        .filter(([key]) => key.startsWith(characterPrefix))
        .reduce((settings, [key, value]) => {
            const settingKey = key.slice(characterPrefix.length);
            return { ...settings, [settingKey]: value };
        }, {});
    if (Object.keys(characterSettings).length > 0) {
        character.settings = character.settings || {};
        character.settings.secrets = {
            ...characterSettings,
            ...character.settings.secrets,
        };
    }
    // Handle plugins
    character.plugins = await handlePluginImporting(character.plugins);
    if (character.extends) {
        elizaLogger.info(
            `Merging  ${character.name} character with parent characters`
        );
        for (const extendPath of character.extends) {
            const baseCharacter = await loadCharacter(
                path.resolve(path.dirname(filePath), extendPath)
            );
            character = mergeCharacters(baseCharacter, character);
            elizaLogger.info(
                `Merged ${character.name} with ${baseCharacter.name}`
            );
        }
    }
    return character;
}

async function loadCharacter(filePath: string): Promise<Character> {
    const content = tryLoadFile(filePath);
    if (!content) {
        throw new Error(`Character file not found: ${filePath}`);
    }
    const character = JSON.parse(content);
    return jsonToCharacter(filePath, character);
}

async function loadCharacterTryPath(characterPath: string): Promise<Character> {
    let content: string | null = null;
    let resolvedPath = "";

    // Try different path resolutions in order
    const pathsToTry = [
        characterPath, // exact path as specified
        path.resolve(process.cwd(), characterPath), // relative to cwd
        path.resolve(process.cwd(), "agent", characterPath), // Add this
        path.resolve(__dirname, characterPath), // relative to current script
        path.resolve(__dirname, "characters", path.basename(characterPath)), // relative to agent/characters
        path.resolve(__dirname, "../characters", path.basename(characterPath)), // relative to characters dir from agent
        path.resolve(
            __dirname,
            "../../characters",
            path.basename(characterPath)
        ), // relative to project root characters dir
    ];

    elizaLogger.info(
        "Trying paths:",
        pathsToTry.map((p) => ({
            path: p,
            exists: fs.existsSync(p),
        }))
    );

    for (const tryPath of pathsToTry) {
        content = tryLoadFile(tryPath);
        if (content !== null) {
            resolvedPath = tryPath;
            break;
        }
    }

    if (content === null) {
        elizaLogger.error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
        elizaLogger.error("Tried the following paths:");
        pathsToTry.forEach((p) => elizaLogger.error(` - ${p}`));
        throw new Error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
    }
    try {
        const character: Character = await loadCharacter(resolvedPath);
        elizaLogger.info(`Successfully loaded character from: ${resolvedPath}`);
        return character;
    } catch (e) {
        elizaLogger.error(`Error parsing character from ${resolvedPath}: ${e}`);
        throw new Error(`Error parsing character from ${resolvedPath}: ${e}`);
    }
}

function commaSeparatedStringToArray(commaSeparated: string): string[] {
    return commaSeparated?.split(",").map((value) => value.trim());
}

async function readCharactersFromStorage(
    characterPaths: string[]
): Promise<string[]> {
    try {
        const uploadDir = path.join(process.cwd(), "data", "characters");
        await fs.promises.mkdir(uploadDir, { recursive: true });
        const fileNames = await fs.promises.readdir(uploadDir);
        fileNames.forEach((fileName) => {
            characterPaths.push(path.join(uploadDir, fileName));
        });
    } catch (err) {
        elizaLogger.error(`Error reading directory: ${err.message}`);
    }

    return characterPaths;
}

export async function loadCharacters(
    charactersArg: string
): Promise<Character[]> {
    let characterPaths = commaSeparatedStringToArray(charactersArg);

    if (process.env.USE_CHARACTER_STORAGE === "true") {
        characterPaths = await readCharactersFromStorage(characterPaths);
    }

    const loadedCharacters: Character[] = [];

    if (characterPaths?.length > 0) {
        for (const characterPath of characterPaths) {
            try {
                const character: Character = await loadCharacterTryPath(
                    characterPath
                );
                loadedCharacters.push(character);
            } catch (e) {
                process.exit(1);
            }
        }
    }

    if (hasValidRemoteUrls()) {
        elizaLogger.info("Loading characters from remote URLs");
        const characterUrls = commaSeparatedStringToArray(
            process.env.REMOTE_CHARACTER_URLS
        );
        for (const characterUrl of characterUrls) {
            const characters = await loadCharactersFromUrl(characterUrl);
            loadedCharacters.push(...characters);
        }
    }

    if (loadedCharacters.length === 0) {
        elizaLogger.info("No characters found, using default character");
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}

async function handlePluginImporting(plugins: string[]) {
    if (plugins.length > 0) {
        elizaLogger.info("Plugins are: ", plugins);
        const importedPlugins = await Promise.all(
            plugins.map(async (plugin) => {
                try {
                    const importedPlugin = await import(plugin);
                    const functionName =
                        plugin
                            .replace("@elizaos/plugin-", "")
                            .replace(/-./g, (x) => x[1].toUpperCase()) +
                        "Plugin"; // Assumes plugin function is camelCased with Plugin suffix
                    return (
                        importedPlugin.default || importedPlugin[functionName]
                    );
                } catch (importError) {
                    elizaLogger.error(
                        `Failed to import plugin: ${plugin}`,
                        importError
                    );
                    return []; // Return null for failed imports
                }
            })
        );
        return importedPlugins;
    } else {
        return [];
    }
}

export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character
): string | undefined {
    switch (provider) {
        // no key needed for llama_local, ollama, lmstudio, gaianet or bedrock
        case ModelProviderName.LLAMALOCAL:
            return "";
        case ModelProviderName.OLLAMA:
            return "";
        case ModelProviderName.LMSTUDIO:
            return "";
        case ModelProviderName.GAIANET:
            return "";
        case ModelProviderName.BEDROCK:
            return "";
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.ETERNALAI:
            return (
                character.settings?.secrets?.ETERNALAI_API_KEY ||
                settings.ETERNALAI_API_KEY
            );
        case ModelProviderName.NINETEEN_AI:
            return (
                character.settings?.secrets?.NINETEEN_AI_API_KEY ||
                settings.NINETEEN_AI_API_KEY
            );
        case ModelProviderName.LLAMACLOUD:
        case ModelProviderName.TOGETHER:
            return (
                character.settings?.secrets?.LLAMACLOUD_API_KEY ||
                settings.LLAMACLOUD_API_KEY ||
                character.settings?.secrets?.TOGETHER_API_KEY ||
                settings.TOGETHER_API_KEY ||
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.CLAUDE_VERTEX:
        case ModelProviderName.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY ||
                settings.CLAUDE_API_KEY
            );
        case ModelProviderName.REDPILL:
            return (
                character.settings?.secrets?.REDPILL_API_KEY ||
                settings.REDPILL_API_KEY
            );
        case ModelProviderName.OPENROUTER:
            return (
                character.settings?.secrets?.OPENROUTER_API_KEY ||
                settings.OPENROUTER_API_KEY
            );
        case ModelProviderName.GROK:
            return (
                character.settings?.secrets?.GROK_API_KEY ||
                settings.GROK_API_KEY
            );
        case ModelProviderName.HEURIST:
            return (
                character.settings?.secrets?.HEURIST_API_KEY ||
                settings.HEURIST_API_KEY
            );
        case ModelProviderName.GROQ:
            return (
                character.settings?.secrets?.GROQ_API_KEY ||
                settings.GROQ_API_KEY
            );
        case ModelProviderName.GALADRIEL:
            return (
                character.settings?.secrets?.GALADRIEL_API_KEY ||
                settings.GALADRIEL_API_KEY
            );
        case ModelProviderName.FAL:
            return (
                character.settings?.secrets?.FAL_API_KEY || settings.FAL_API_KEY
            );
        case ModelProviderName.ALI_BAILIAN:
            return (
                character.settings?.secrets?.ALI_BAILIAN_API_KEY ||
                settings.ALI_BAILIAN_API_KEY
            );
        case ModelProviderName.VOLENGINE:
            return (
                character.settings?.secrets?.VOLENGINE_API_KEY ||
                settings.VOLENGINE_API_KEY
            );
        case ModelProviderName.NANOGPT:
            return (
                character.settings?.secrets?.NANOGPT_API_KEY ||
                settings.NANOGPT_API_KEY
            );
        case ModelProviderName.HYPERBOLIC:
            return (
                character.settings?.secrets?.HYPERBOLIC_API_KEY ||
                settings.HYPERBOLIC_API_KEY
            );

        case ModelProviderName.VENICE:
            return (
                character.settings?.secrets?.VENICE_API_KEY ||
                settings.VENICE_API_KEY
            );
        case ModelProviderName.ATOMA:
            return (
                character.settings?.secrets?.ATOMASDK_BEARER_AUTH ||
                settings.ATOMASDK_BEARER_AUTH
            );
        case ModelProviderName.NVIDIA:
            return (
                character.settings?.secrets?.NVIDIA_API_KEY ||
                settings.NVIDIA_API_KEY
            );
        case ModelProviderName.AKASH_CHAT_API:
            return (
                character.settings?.secrets?.AKASH_CHAT_API_KEY ||
                settings.AKASH_CHAT_API_KEY
            );
        case ModelProviderName.GOOGLE:
            return (
                character.settings?.secrets?.GOOGLE_GENERATIVE_AI_API_KEY ||
                settings.GOOGLE_GENERATIVE_AI_API_KEY
            );
        case ModelProviderName.MISTRAL:
            return (
                character.settings?.secrets?.MISTRAL_API_KEY ||
                settings.MISTRAL_API_KEY
            );
        case ModelProviderName.LETZAI:
            return (
                character.settings?.secrets?.LETZAI_API_KEY ||
                settings.LETZAI_API_KEY
            );
        case ModelProviderName.INFERA:
            return (
                character.settings?.secrets?.INFERA_API_KEY ||
                settings.INFERA_API_KEY
            );
        case ModelProviderName.DEEPSEEK:
            return (
                character.settings?.secrets?.DEEPSEEK_API_KEY ||
                settings.DEEPSEEK_API_KEY
            );
        case ModelProviderName.LIVEPEER:
            return (
                character.settings?.secrets?.LIVEPEER_GATEWAY_URL ||
                settings.LIVEPEER_GATEWAY_URL
            );
        default:
            const errorMessage = `Failed to get token - unsupported model provider: ${provider}`;
            elizaLogger.error(errorMessage);
            throw new Error(errorMessage);
    }
}

function initializeDatabase(dataDir: string) {
    if (process.env.MONGODB_CONNECTION_STRING) {
        elizaLogger.log("Initializing database on MongoDB Atlas");
        const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING, {
            maxPoolSize: 100,
            minPoolSize: 5,
            maxIdleTimeMS: 60000,
            connectTimeoutMS: 10000,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            compressors: ["zlib"],
            retryWrites: true,
            retryReads: true,
        });

        const dbName = process.env.MONGODB_DATABASE || "elizaAgent";
        const db = new MongoDBDatabaseAdapter(client, dbName);

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success("Successfully connected to MongoDB Atlas");
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to MongoDB Atlas:", error);
                throw error; // Re-throw to handle it in the calling code
            });

        return db;
    } else if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        elizaLogger.info("Initializing Supabase connection...");
        const db = new SupabaseDatabaseAdapter(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to Supabase database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to Supabase:", error);
            });

        return db;
    } else if (process.env.POSTGRES_URL) {
        elizaLogger.info("Initializing PostgreSQL connection...");
        const db = new PostgresDatabaseAdapter({
            connectionString: process.env.POSTGRES_URL,
            ssl: {
                rejectUnauthorized: false, // Disable strict certificate validation for testing
            },
            parseInputs: true,
        });

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to PostgreSQL database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to PostgreSQL:", error);
            });

        return db;
    } else if (process.env.PGLITE_DATA_DIR) {
        elizaLogger.info("Initializing PgLite adapter...");
        // `dataDir: memory://` for in memory pg
        const db = new PGLiteDatabaseAdapter({
            dataDir: process.env.PGLITE_DATA_DIR,
        });
        return db;
    } else if (
        process.env.QDRANT_URL &&
        process.env.QDRANT_KEY &&
        process.env.QDRANT_PORT &&
        process.env.QDRANT_VECTOR_SIZE
    ) {
        elizaLogger.info("Initializing Qdrant adapter...");
        const db = new QdrantDatabaseAdapter(
            process.env.QDRANT_URL,
            process.env.QDRANT_KEY,
            Number(process.env.QDRANT_PORT),
            Number(process.env.QDRANT_VECTOR_SIZE)
        );
        return db;
    } else {
        const filePath =
            process.env.SQLITE_FILE ?? path.resolve(dataDir, "db.sqlite");
        elizaLogger.info(`Initializing SQLite database at ${filePath}...`);

        const db = new SqliteDatabaseAdapter(new Database(filePath));

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to SQLite database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to SQLite:", error);
            });

        return db;
    }
}

// also adds plugins from character file into the runtime
export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    // each client can only register once
    // and if we want two we can explicitly support it
    const clients: Record<string, any> = {};
    const clientTypes: string[] =
        character.clients?.map((str) => str.toLowerCase()) || [];
    elizaLogger.log("initializeClients", clientTypes, "for", character.name);

    // Start Auto Client if "auto" detected as a configured client
    if (clientTypes.includes(Clients.AUTO)) {
        const autoClient = await AutoClientInterface.start(runtime);
        if (autoClient) clients.auto = autoClient;
    }

    if (clientTypes.includes(Clients.DISCORD)) {
        const discordClient = await DiscordClientInterface.start(runtime);
        if (discordClient) clients.discord = discordClient;
    }

    if (clientTypes.includes(Clients.TELEGRAM)) {
        const telegramClient = await TelegramClientInterface.start(runtime);
        if (telegramClient) clients.telegram = telegramClient;
    }

    if (clientTypes.includes(Clients.TELEGRAM_ACCOUNT)) {
        const telegramAccountClient =
            await TelegramAccountClientInterface.start(runtime);
        if (telegramAccountClient)
            clients.telegram_account = telegramAccountClient;
    }

    if (clientTypes.includes(Clients.TWITTER)) {
        const twitterClient = await TwitterClientInterface.start(runtime);
        if (twitterClient) {
            clients.twitter = twitterClient;
        }
    }

    if (clientTypes.includes(Clients.INSTAGRAM)) {
        const instagramClient = await InstagramClientInterface.start(runtime);
        if (instagramClient) {
            clients.instagram = instagramClient;
        }
    }

    if (clientTypes.includes(Clients.FARCASTER)) {
        const farcasterClient = await FarcasterClientInterface.start(runtime);
        if (farcasterClient) {
            clients.farcaster = farcasterClient;
        }
    }

    elizaLogger.log("client keys", Object.keys(clients));

    function determineClientType(client: Client): string {
        // Check if client has a direct type identifier
        if ("type" in client) {
            return (client as any).type;
        }

        // Check constructor name
        const constructorName = client.constructor?.name;
        if (constructorName && !constructorName.includes("Object")) {
            return constructorName.toLowerCase().replace("client", "");
        }

        // Fallback: Generate a unique identifier
        return `client_${Date.now()}`;
    }

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            if (plugin.clients) {
                for (const client of plugin.clients) {
                    const startedClient = await client.start(runtime);
                    const clientType = determineClientType(client);
                    elizaLogger.debug(
                        `Initializing client of type: ${clientType}`
                    );
                    clients[clientType] = startedClient;
                }
            }
        }
    }

    return clients;
}

function getSecret(character: Character, secret: string) {
    return character.settings?.secrets?.[secret] || process.env[secret];
}

let nodePlugin: any | undefined;

export async function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    cache: ICacheManager,
    token: string
): Promise<AgentRuntime> {
    elizaLogger.log(`Creating runtime for character ${character.name}`);

    nodePlugin ??= createNodePlugin();

    const teeMode = getSecret(character, "TEE_MODE") || "OFF";
    const walletSecretSalt = getSecret(character, "WALLET_SECRET_SALT");

    // Validate TEE configuration
    let goatPlugin: any | undefined;

    if (getSecret(character, "EVM_PRIVATE_KEY")) {
        goatPlugin = await createGoatPlugin((secret) =>
            getSecret(character, secret)
        );
    }

    let zilliqaPlugin: any | undefined;

    // Initialize Reclaim adapter if environment variables are present
    // let verifiableInferenceAdapter;
    // if (
    //     process.env.RECLAIM_APP_ID &&
    //     process.env.RECLAIM_APP_SECRET &&
    //     process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    // ) {
    //     verifiableInferenceAdapter = new ReclaimAdapter({
    //         appId: process.env.RECLAIM_APP_ID,
    //         appSecret: process.env.RECLAIM_APP_SECRET,
    //         modelProvider: character.modelProvider,
    //         token,
    //     });
    //     elizaLogger.log("Verifiable inference adapter initialized");
    // }
    // Initialize Opacity adapter if environment variables are present

    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        // character.plugins are handled when clients are added
        plugins: [
            bootstrapPlugin,
            nodePlugin,
            getSecret(character, "NEWS_API_KEY") ? newsPlugin : null,
            getSecret(character, "OPEN_WEATHER_API_KEY")
                ? openWeatherPlugin
                : null,
            getSecret(character, "OPENAI_API_KEY") &&
            parseBooleanFromText(
                getSecret(character, "ENABLE_OPEN_AI_COMMUNITY_PLUGIN")
            )
                ? openaiPlugin
                : null,
        ]
            .flat()
            .filter(Boolean),
        providers: [newsProvider],
        managers: [],
        cacheManager: cache,
        fetch: logFetch,
    });
}

function initializeFsCache(baseDir: string, character: Character) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cacheDir = path.resolve(baseDir, character.id, "cache");

    const cache = new CacheManager(new FsCacheAdapter(cacheDir));
    return cache;
}

function initializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cache = new CacheManager(new DbCacheAdapter(db, character.id));
    return cache;
}

function initializeCache(
    cacheStore: string,
    character: Character,
    baseDir?: string,
    db?: IDatabaseCacheAdapter
) {
    switch (cacheStore) {
        case CacheStore.REDIS:
            if (process.env.REDIS_URL) {
                elizaLogger.info("Connecting to Redis...");
                const redisClient = new RedisClient(process.env.REDIS_URL);
                if (!character?.id) {
                    throw new Error(
                        "CacheStore.REDIS requires id to be set in character definition"
                    );
                }
                return new CacheManager(
                    new DbCacheAdapter(redisClient, character.id) // Using DbCacheAdapter since RedisClient also implements IDatabaseCacheAdapter
                );
            } else {
                throw new Error("REDIS_URL environment variable is not set.");
            }

        case CacheStore.DATABASE:
            if (db) {
                elizaLogger.info("Using Database Cache...");
                return initializeDbCache(character, db);
            } else {
                throw new Error(
                    "Database adapter is not provided for CacheStore.Database."
                );
            }

        case CacheStore.FILESYSTEM:
            elizaLogger.info("Using File System Cache...");
            if (!baseDir) {
                throw new Error(
                    "baseDir must be provided for CacheStore.FILESYSTEM."
                );
            }
            return initializeFsCache(baseDir, character);

        default:
            throw new Error(
                `Invalid cache store: ${cacheStore} or required configuration missing.`
            );
    }
}

async function startAgent(
    character: Character,
    directClient: DirectClient
): Promise<AgentRuntime> {
    let db: IDatabaseAdapter & IDatabaseCacheAdapter;
    try {
        character.id ??= stringToUuid(character.name);
        character.username ??= character.name;

        const token = getTokenForProvider(character.modelProvider, character);
        const dataDir = path.join(__dirname, "../data");

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        db = (await initializeDatabase(dataDir)) as IDatabaseAdapter &
            IDatabaseCacheAdapter;

        const cache = initializeCache(
            process.env.CACHE_STORE ?? CacheStore.DATABASE,
            character,
            "",
            db
        ); // "" should be replaced with dir for file system caching. THOUGHTS: might probably make this into an env
        const runtime: AgentRuntime = await createAgent(
            character,
            db,
            cache,
            token
        );

        // start services/plugins/process knowledge
        await runtime.initialize();

        // start assigned clients
        runtime.clients = await initializeClients(character, runtime);

        // add to container
        directClient.registerAgent(runtime);

        elizaLogger.info(`Started at database: ${runtime.databaseAdapter.db}`);
        // report to console
        elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

        return runtime;
    } catch (error) {
        elizaLogger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        elizaLogger.error(error);
        if (db) {
            await db.close();
        }
        throw error;
    }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
            }
        });

        server.once("listening", () => {
            server.close();
            resolve(true);
        });

        server.listen(port);
    });
};

const hasValidRemoteUrls = () =>
    process.env.REMOTE_CHARACTER_URLS &&
    process.env.REMOTE_CHARACTER_URLS !== "" &&
    process.env.REMOTE_CHARACTER_URLS.startsWith("http");

const startAgents = async () => {
    const directClient = new DirectClient();
    let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
    const args = parseArguments();
    const charactersArg = args.characters || args.character;
    let characters = [defaultCharacter];

    if (charactersArg || hasValidRemoteUrls()) {
        characters = await loadCharacters(charactersArg);
    }

    try {
        for (const character of characters) {
            await startAgent(character, directClient);
        }
    } catch (error) {
        elizaLogger.error("Error starting agents:", error);
    }

    // Find available port
    while (!(await checkPortAvailable(serverPort))) {
        elizaLogger.warn(
            `Port ${serverPort} is in use, trying ${serverPort + 1}`
        );
        serverPort++;
    }

    // upload some agent functionality into directClient
    directClient.startAgent = async (character) => {
        // Handle plugins
        character.plugins = await handlePluginImporting(character.plugins);

        // wrap it so we don't have to inject directClient later
        return startAgent(character, directClient);
    };

    directClient.loadCharacterTryPath = loadCharacterTryPath;
    directClient.jsonToCharacter = jsonToCharacter;

    directClient.start(serverPort);

    if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
        elizaLogger.log(`Server started on alternate port ${serverPort}`);
    }

    elizaLogger.log(
        "Run `pnpm start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents. When running multiple agents, use client with different port `SERVER_PORT=3001 pnpm start:client`"
    );
};

startAgents().catch((error) => {
    elizaLogger.error("Unhandled error in startAgents:", error);
    process.exit(1);
});

// Prevent unhandled exceptions from crashing the process if desired
if (
    process.env.PREVENT_UNHANDLED_EXIT &&
    parseBooleanFromText(process.env.PREVENT_UNHANDLED_EXIT)
) {
    // Handle uncaught exceptions to prevent the process from crashing
    process.on("uncaughtException", function (err) {
        console.error("uncaughtException", err);
    });

    // Handle unhandled rejections to prevent the process from crashing
    process.on("unhandledRejection", function (err) {
        console.error("unhandledRejection", err);
    });
}
