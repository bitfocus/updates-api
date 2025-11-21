import { APIServer, ValidationError, z } from "@bitfocusas/api";

// In-memory data store
const users: Array<{
  id: string;
  name: string;
  email: string;
  age?: number;
  createdAt: string;
}> = [];

// Create API server
const app = new APIServer({
  port: 3000,
  host: "::",
  apiTitle: "Companion Update API",
  apiDescription: "Companion Update API",
  // apiTags: [{ name: "Users", description: "User management endpoints" }],
  loadEnv: false,
  metricsEnabled: true, // TODO - limit permissions of this?
});

// Define schemas with .describe() for better OpenAPI documentation
const CreateUserBody = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .max(100, "Name must be less than 100 characters")
    .describe("Full name of the user"),
  email: z
    .string()
    .email("Invalid email address")
    .describe("Email address (must be unique)"),
  age: z
    .number()
    .int()
    .positive("Age must be a positive number")
    .optional()
    .describe("Age in years (optional)"),
});

const UserResponse = z.object({
  id: z.string().describe("Unique user identifier (UUID)"),
  name: z.string().describe("Full name of the user"),
  email: z.string().describe("Email address"),
  age: z.number().optional().describe("Age in years"),
  createdAt: z
    .string()
    .describe("ISO 8601 timestamp of when the user was created"),
});

// Create user endpoint
app.createEndpoint({
  method: "POST",
  url: "/users",
  body: CreateUserBody,
  response: UserResponse,
  config: {
    description: "Create a new user",
    tags: ["Users"],
    summary: "Create user",
  },
  handler: async (request) => {
    const { name, email, age } = request.body;

    // Check if email already exists
    const existingUser = users.find((u) => u.email === email);
    if (existingUser) {
      throw new ValidationError([
        {
          field: "body.email",
          message: "User with this email already exists",
        },
      ]);
    }

    // Create new user
    const newUser = {
      id: crypto.randomUUID(),
      name,
      email,
      age,
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);

    return newUser;
  },
});

// Get all users endpoint
app.createEndpoint({
  method: "GET",
  url: "/users",
  response: z.object({
    users: z.array(UserResponse),
    total: z.number(),
  }),
  config: {
    description: "Get all users",
    tags: ["Users"],
    summary: "List users",
  },
  handler: async () => {
    return {
      users,
      total: users.length,
    };
  },
});

// Setup graceful shutdown
app.setupGracefulShutdown();

// Start the server
await app.start();
