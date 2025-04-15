import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { auth } from "./utils/auth";
import { ensureNotFalsy, lastOfArray, type RxReplicationWriteToMasterRow } from "rxdb/plugins/core";
import { PrismaClient, Prisma } from "./generated/client";
import { deepCompare } from "./utils/deepCompare";
import { HTTPException } from 'hono/http-exception'
import type { Bindings } from './index';
import prismaClients from "./prisma/client";

// Define models with different ID fields
type BaseModel = {
    serverTimestamp: Date;
    userId: string;
    deleted: boolean;
};

type IdModel = BaseModel & {
    id: string;
};

type UuidModel = BaseModel & {
    uuid: string;
};

// The Model type can be either IdModel or UuidModel
type Model = IdModel | UuidModel;

// Define a helper type to transform Prisma models to RxDB documents
type RxDocument<T> = Omit<T, 'userId' | 'serverTimestamp' | 'deleted'> & { _deleted: boolean };

// Define checkpoint types based on idField
type IdCheckpoint = {
    id: string;
    serverTimestamp: string;
};

type UuidCheckpoint = {
    uuid: string;
    serverTimestamp: string;
};

// Conditional type to select the right checkpoint based on idField
type Checkpoint<T extends 'id' | 'uuid'> = T extends 'id' ? IdCheckpoint : UuidCheckpoint;

/**
 * Generic function to handle pull operations for any collection
 * @template M The specific model type (with either id or uuid required)
 * @template IdField The ID field type ('id' or 'uuid')
 */
async function handlePullRequest<
    M extends Model,
    IdField extends 'id' | 'uuid' = 'id' | 'uuid'
>(
    prisma: PrismaClient,
    userId: string | undefined,
    collection: any,
    idField: IdField,
    queryParams: {
        id?: string,
        uuid?: string,
        serverTimestamp?: string,
        batchSize?: number
    },
    orderBy: Array<{ [key: string]: 'asc' | 'desc' }>
): Promise<{
    checkpoint: Checkpoint<IdField> | null;
    documents: RxDocument<M>[];
}> {
    if (!userId) {
        throw new Error("User ID is required");
    }

    const id = queryParams[idField];
    const { serverTimestamp, batchSize = 10 } = queryParams;
    const lastPulledTimestamp = serverTimestamp ? new Date(serverTimestamp) : null;

    let items;

    if (lastPulledTimestamp) {
        items = await collection.findMany({
            where: {
                userId,
                OR: [
                    {
                        serverTimestamp: {
                            gt: lastPulledTimestamp
                        },
                    },
                    {
                        AND: [
                            { serverTimestamp: lastPulledTimestamp },
                            { [idField]: { gt: id } }
                        ]
                    }
                ]
            },
            orderBy,
            take: batchSize
        });
    } else {
        items = await collection.findMany({
            where: {
                userId
            },
            orderBy,
            take: batchSize
        });
    }

    if (items.length === 0) {
        return {
            checkpoint: lastPulledTimestamp ? { [idField]: id || "", serverTimestamp: lastPulledTimestamp.toISOString() } as Checkpoint<IdField> : null,
            documents: []
        };
    }

    const lastDoc = ensureNotFalsy(lastOfArray(items)) as M;
    const documents = items.map((item: M) => {
        const { userId, serverTimestamp, deleted, ...itemData } = item;

        // Create a copy of itemData for transformations
        const transformedData = { ...itemData };

        // Deserialize dependson if it exists (for Item model)
        if ('dependson' in transformedData && typeof transformedData.dependson === 'string') {
            transformedData.dependson = transformedData.dependson ?
                JSON.parse(transformedData.dependson) : null;
        }

        // Deserialize includedSemesters if it exists (for PlannerData model)
        if ('includedSemesters' in transformedData && typeof transformedData.includedSemesters === 'string') {
            transformedData.includedSemesters = transformedData.includedSemesters ?
                JSON.parse(transformedData.includedSemesters) : [];
        }

        // Map deleted field to _deleted for RxDB
        return {
            ...transformedData,
            _deleted: deleted || false
        };
    });

    const newCheckpoint = {
        [idField]: lastDoc[idField as unknown as keyof M] as string,
        serverTimestamp: (lastDoc.serverTimestamp as Date).toISOString()
    } as Checkpoint<IdField>;

    return {
        documents,
        checkpoint: newCheckpoint
    };
}

/**
 * Generic function to handle push operations for any collection
 * @template M The specific model type (with either id or uuid required)
 */
async function handlePushRequest<M extends Model>(
    prisma: PrismaClient,
    userId: string | undefined,
    collection: any,
    idField: 'id' | 'uuid',
    rows: RxReplicationWriteToMasterRow<RxDocument<IdModel | UuidModel>>[],
    uniqueConstraint: { [key: string]: string } | null = null
): Promise<RxDocument<M>[]> {
    if (!userId) {
        throw new Error("User ID is required");
    }

    const conflicts: RxDocument<M>[] = [];

    // Process each row separately first to determine conflicts
    for (const row of rows) {
        const { newDocumentState, assumedMasterState } = row;
        const id = newDocumentState[idField as keyof typeof newDocumentState];

        // Build where clause for the unique constraint
        const whereClause = uniqueConstraint
            ? {
                [uniqueConstraint.name]: {
                    userId,
                    [idField]: id
                }
            }
            : {
                [idField]: id,
                userId
            };

        // Find the current state in the database
        const itemInDb = await collection.findUnique({
            where: whereClause
        });

        // Check for conflicts
        if (itemInDb) {
            const { userId, serverTimestamp, deleted, ...itemData } = itemInDb;

            // Create a copy for transformations
            const transformedData = { ...itemData };

            // Deserialize JSON strings for comparison
            if ('dependson' in transformedData && typeof transformedData.dependson === 'string') {
                transformedData.dependson = transformedData.dependson ?
                    JSON.parse(transformedData.dependson) : null;
            }

            if ('includedSemesters' in transformedData && typeof transformedData.includedSemesters === 'string') {
                transformedData.includedSemesters = transformedData.includedSemesters ?
                    JSON.parse(transformedData.includedSemesters) : [];
            }

            // Need to map deleted to _deleted for comparison with assumedMasterState
            const itemDataForComparison = {
                ...transformedData,
                _deleted: deleted || false
            } as RxDocument<M>;

            // If we have an assumed state but it doesn't match what's in the DB, it's a conflict
            if (assumedMasterState && !deepCompare(itemDataForComparison, assumedMasterState)) {
                conflicts.push(itemDataForComparison);
                continue;
            }
        }
    }

    // If there are no conflicts, process all rows in a batch transaction
    if (conflicts.length === 0) {
        const operations = [];

        for (const row of rows) {
            const { newDocumentState } = row;
            const id = newDocumentState[idField as keyof typeof newDocumentState];

            // Build where clause for the unique constraint
            const whereClause = uniqueConstraint
                ? {
                    [uniqueConstraint.name]: {
                        userId,
                        [idField]: id
                    }
                }
                : {
                    [idField]: id,
                    userId
                };

            // Check if the document should be deleted
            if (newDocumentState._deleted) {
                operations.push(
                    collection.update({
                        where: whereClause,
                        data: {
                            deleted: true,
                            serverTimestamp: new Date()
                        }
                    })
                );
                continue;
            }

            // Prepare data for create/update
            const { _deleted, ...itemData } = newDocumentState;

            // Create a copy for transformations
            const transformedData = { ...itemData };

            // Serialize arrays/objects to JSON strings
            if ('dependson' in transformedData && transformedData.dependson !== null &&
                (Array.isArray(transformedData.dependson) || typeof transformedData.dependson === 'object')) {
                transformedData.dependson = JSON.stringify(transformedData.dependson);
            }

            if ('includedSemesters' in transformedData && Array.isArray(transformedData.includedSemesters)) {
                transformedData.includedSemesters = JSON.stringify(transformedData.includedSemesters);
            }

            const data = {
                ...transformedData,
                userId,
                deleted: false, // Ensure deleted is set to false for non-delete operations
            };

            // Add upsert operation to transaction
            operations.push(
                collection.upsert({
                    where: whereClause,
                    update: data,
                    create: data
                })
            );
        }

        // Execute all operations in a batch transaction
        if (operations.length > 0) {
            await prisma.$transaction(operations);
        }
    }

    // Ensure all conflicts have the _deleted property properly mapped from deleted
    return conflicts.map(conflict => {
        if ('deleted' in conflict) {
            const { deleted, ...rest } = conflict;
            return { ...rest, _deleted: deleted || false } as RxDocument<M>;
        }
        return conflict;
    });
}

const app = new Hono<{ Bindings: Bindings }>()
    .use(auth(["planner"]))
    .get(
        "/folders/pull",
        zValidator(
            "query",
            z.object({
                id: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);

                // Explicitly typing the result with IdCheckpoint for clarity
                const result = await handlePullRequest<Prisma.FolderGetPayload<{}>, 'id'>(
                    prisma,
                    user.sub,
                    prisma.folder,
                    'id',
                    params,
                    [{ serverTimestamp: 'asc' }, { id: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in folders/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/folders/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean()
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const conflicts = await handlePushRequest<Prisma.FolderGetPayload<{}>>(
                    prisma,
                    user.sub,
                    prisma.folder,
                    'id',
                    rows,
                    { name: 'userId_id' }
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in folders/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .get(
        "/items/pull",
        zValidator(
            "query",
            z.object({
                uuid: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const result = await handlePullRequest<Prisma.ItemGetPayload<{}>, 'uuid'>(
                    prisma,
                    user.sub,
                    prisma.item,
                    'uuid',
                    params,
                    [{ serverTimestamp: 'asc' }, { uuid: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in items/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/items/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            uuid: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            uuid: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const conflicts = await handlePushRequest<Prisma.ItemGetPayload<{}>>(
                    prisma,
                    user.sub,
                    prisma.item,
                    'uuid',
                    rows,
                    null
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in items/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .get(
        "/plannerdata/pull",
        zValidator(
            "query",
            z.object({
                id: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const result = await handlePullRequest<Prisma.PlannerDataGetPayload<{}>, 'id'>(
                    prisma,
                    user.sub,
                    prisma.plannerData,
                    'id',
                    params,
                    [{ serverTimestamp: 'asc' }, { id: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in plannerdata/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/plannerdata/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const conflicts = await handlePushRequest<Prisma.PlannerDataGetPayload<{}>>(
                    prisma,
                    user.sub,
                    prisma.plannerData,
                    'id',
                    rows,
                    { name: 'userId_id' }
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in plannerdata/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .get(
        "/semesters/pull",
        zValidator(
            "query",
            z.object({
                id: z.string(),
                serverTimestamp: z.string(),
                batchSize: z.coerce.number().optional(),
            })
        ),
        async (c) => {
            try {
                const params = c.req.valid("query");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const result = await handlePullRequest<Prisma.SemesterGetPayload<{}>, 'id'>(
                    prisma,
                    user.sub,
                    prisma.semester,
                    'id',
                    params,
                    [{ serverTimestamp: 'asc' }, { id: 'asc' }]
                );

                return c.json(result);
            } catch (error) {
                console.error("Error in semesters/pull:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    )
    .post(
        "/semesters/push",
        zValidator(
            "json",
            z.array(
                z.object({
                    newDocumentState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough(),
                    assumedMasterState: z
                        .object({
                            id: z.string(),
                            _deleted: z.boolean(),
                        })
                        .passthrough()
                        .optional(),
                })
            )
        ),
        async (c) => {
            try {
                const rows = c.req.valid("json");
                const user = c.get("user");

                const prisma = await prismaClients.fetch(c.env.DB);
                const conflicts = await handlePushRequest<Prisma.SemesterGetPayload<{}>>(
                    prisma,
                    user.sub,
                    prisma.semester,
                    'id',
                    rows,
                    { name: 'userId_id' }
                );

                return c.json(conflicts);
            } catch (error) {
                console.error("Error in semesters/push:", error);
                throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Unknown error' });
            }
        }
    );

export default app;