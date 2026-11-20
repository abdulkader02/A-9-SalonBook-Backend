import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = 5000;

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status !== "paid") {
        console.log(
          "Checkout completed but payment not confirmed yet:",
          session.id,
        );
        return res.json({ received: true });
      }

      try {
        const appointmentId = session.metadata.appointmentId;

        // Stripe can send the same event more than once, so skip if already saved
        const alreadySaved = await transactions.findOne({
          stripeSessionId: session.id,
        });
        if (alreadySaved) {
          return res.json({ received: true });
        }

        await appointments.updateOne(
          { _id: new ObjectId(appointmentId) },
          { $set: { paymentStatus: "paid" } },
        );

        await transactions.insertOne({
          appointmentId: appointmentId,
          customerId: session.metadata.customerId,
          amount: session.amount_total / 100,
          currency: session.currency,
          stripeSessionId: session.id,
          status: "paid",
          createdAt: new Date(),
        });

        console.log("Appointment marked as paid:", appointmentId);
      } catch (err) {
        console.error("Failed to update appointment after payment:", err);
        // 500 tells Stripe to retry the event later
        return res
          .status(500)
          .json({ message: "Failed to process payment event" });
      }
    }

    res.json({ received: true });
  },
);

app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("salonbook");
const users = db.collection("user");
const services = db.collection("services");
const sessions = db.collection("session");
const appointments = db.collection("appointments");
const transactions = db.collection("transactions");

/* ======================================================
   AUTH MIDDLEWARE
====================================================== */

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const token = authHeader.split(" ")[1];

    const session = await sessions.findOne({ token: token });

    if (!session) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    if (new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ message: "Session expired" });
    }

    const user = await users.findOne({ _id: session.userId });

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (user.isBlocked) {
      return res.status(403).json({ message: "Your account has been blocked" });
    }

    req.user = {
      id: user._id.toString(),
      role: user.role,
      isBlocked: user.isBlocked,
    };

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ message: "Authentication check failed" });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

app.get("/", (req, res) => {
  res.send("Hello World!");
});

/* ======================================================
   USER ROUTES
====================================================== */

// CHANGED: was fully open (returned every user to anyone). Now admin-only,
// since this exposes every registered account.
app.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const allUsers = await users.find().toArray();
  res.json(allUsers);
});

// CHANGED: added requireAuth + ownership check. Assignment rule: "Users must
// not be able to update another user's profile" - so a logged-in user may
// only fetch their own profile through this route.
app.get("/users/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    // Ownership check: you can only read your own profile through this route
    if (req.user.id !== id) {
      return res.status(403).json({
        success: false,
        message: "You can only view your own profile",
      });
    }

    const user = await users.findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          phone: 1,
          role: 1,
          isBlocked: 1,
        },
      },
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Profile retrieved successfully",
      data: user,
    });
  } catch (err) {
    console.error("Failed to fetch user profile:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
    });
  }
});

// CHANGED: added requireAuth + ownership check. Assignment rule: "Users must
// not be able to update another user's profile" - previously anyone could
// PATCH any user ID.
app.patch("/users/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, image, phone } = req.body;

    // Validate user ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID",
      });
    }

    // Ownership check: you can only update your own profile
    if (req.user.id !== id) {
      return res.status(403).json({
        success: false,
        message: "You can only update your own profile",
      });
    }

    // Check if user exists
    const user = await users.findOne({
      _id: new ObjectId(id),
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Prepare update data
    const updateData = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Name cannot be empty",
        });
      }

      updateData.name = name.trim();
    }

    if (image !== undefined) {
      if (typeof image !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid image URL",
        });
      }

      if (image.trim()) {
        updateData.image = image.trim();
      }
    }

    if (phone !== undefined) {
      if (typeof phone !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid phone number",
        });
      }

      updateData.phone = phone.trim();
    }

    // Check if there is anything to update
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update",
      });
    }

    // Update user
    await users.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          ...updateData,
          updatedAt: new Date(),
        },
      },
    );

    // Get updated user
    const updatedUser = await users.findOne(
      { _id: new ObjectId(id) },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          phone: 1,
          role: 1,
          isBlocked: 1,
        },
      },
    );

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedUser,
    });
  } catch (err) {
    console.error("Failed to update user profile:", err);

    res.status(500).json({
      success: false,
      message: "Failed to update profile",
    });
  }
});

// CHANGED: added requireAuth, requireAdmin.
app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const allCustomers = await users
      .find(
        { role: "customer" },
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            phone: 1,
            isBlocked: 1,
            createdAt: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .toArray();

    res.json(allCustomers);
  } catch (err) {
    console.error("Failed to fetch customers:", err);
    res.status(500).json({ message: "Failed to fetch customers" });
  }
});

// CHANGED: added requireAuth, requireAdmin.
app.get("/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  try {
    const totalCustomers = await users.countDocuments({ role: "customer" });
    const totalActiveServices = await services.countDocuments({
      status: "active",
    });
    const totalAppointments = await appointments.countDocuments({});
    const pendingAppointments = await appointments.countDocuments({
      status: "pending",
    });
    const confirmedAppointments = await appointments.countDocuments({
      status: "confirmed",
    });
    const successfulPayments = await appointments.countDocuments({
      paymentStatus: "paid",
    });

    res.json({
      totalCustomers,
      totalActiveServices,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      successfulPayments,
    });
  } catch (err) {
    console.error("Failed to fetch admin stats:", err);
    res.status(500).json({ message: "Failed to fetch stats" });
  }
});

// CHANGED: added requireAuth, requireAdmin.
app.patch("/users/:id/block", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isBlocked } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    if (typeof isBlocked !== "boolean") {
      return res
        .status(400)
        .json({ message: "isBlocked must be true or false" });
    }

    const user = await users.findOne({ _id: new ObjectId(id) });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.role !== "customer") {
      return res.status(400).json({ message: "Only customers can be blocked" });
    }

    await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isBlocked: isBlocked } },
    );

    res.json({
      message: isBlocked
        ? "User blocked successfully"
        : "User unblocked successfully",
    });
  } catch (err) {
    console.error("Failed to update block status:", err);
    res.status(500).json({ message: "Failed to update block status" });
  }
});
/* ======================================================
   SERVICE ROUTES (PUBLIC)
====================================================== */

app.get("/services", async (req, res) => {
  try {
    const { search, category, sort } = req.query;

    // Public browsing should only ever return active services
    const filter = { status: { $ne: "inactive" } };

    if (search) {
      // Case-insensitive match on service name
      filter.serviceName = { $regex: search, $options: "i" };
    }

    if (category && category !== "all") {
      filter.category = category;
    }

    let sortOption = {};
    if (sort === "price-asc") sortOption = { price: 1 };
    if (sort === "price-desc") sortOption = { price: -1 };

    const allServices = await services.find(filter).sort(sortOption).toArray();

    res.json(allServices);
  } catch (err) {
    console.error("Failed to fetch services:", err);
    res.status(500).json({ message: "Failed to fetch services" });
  }
});

app.get("/services/featured", async (req, res) => {
  try {
    const featuredServices = await services
      .find({ status: "active" })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    const result = featuredServices.map((service) => {
      const description = service.description || "";
      const shortDescription =
        description.length > 100
          ? description.slice(0, 100).trimEnd() + "..."
          : description;

      return {
        _id: service._id,
        serviceName: service.serviceName,
        category: service.category,
        price: service.price,
        duration: service.duration,
        image: service.image,
        shortDescription,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch featured services:", err);
    res.status(500).json({ message: "Failed to fetch featured services" });
  }
});

app.get("/services/:id", async (req, res) => {
  try {
    const serviceId = req.params.id;
    const service = await services.findOne({ _id: new ObjectId(serviceId) });

    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    res.json(service);
  } catch (err) {
    console.error("Failed to fetch service:", err);
    res.status(400).json({ message: "Invalid service ID" });
  }
});

/* ======================================================
   SERVICE ROUTES (ADMIN - CREATE / UPDATE / DELETE)
====================================================== */

app.get("/admin/services", requireAuth, requireAdmin, async (req, res) => {
  try {
    const allServices = await services.find().sort({ createdAt: -1 }).toArray();
    res.json(allServices);
  } catch (err) {
    console.error("Failed to fetch admin services:", err);
    res.status(500).json({ message: "Failed to fetch services" });
  }
});

// CHANGED: added requireAuth, requireAdmin. Assignment rule: "Only Admin can
// create, update, or delete services."
app.post("/services", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      serviceName,
      category,
      description,
      price,
      duration,
      image,
      status,
    } = req.body;

    if (
      !serviceName?.trim() ||
      !category?.trim() ||
      !description?.trim() ||
      !image?.trim()
    ) {
      return res.status(400).json({
        message: "Name, category, description and image are required",
      });
    }

    if (!(Number(price) > 0)) {
      return res
        .status(400)
        .json({ message: "Price must be a positive number" });
    }

    if (!(Number(duration) > 0)) {
      return res
        .status(400)
        .json({ message: "Duration must be a positive number" });
    }

    if (status !== undefined && !["active", "inactive"].includes(status)) {
      return res
        .status(400)
        .json({ message: "Status must be active or inactive" });
    }

    const newService = {
      serviceName: serviceName.trim(),
      category: category.trim(),
      description: description.trim(),
      price: Number(price),
      duration: Number(duration),
      image: image.trim(),
      status: status || "active",
      createdAt: new Date(),
    };

    const result = await services.insertOne(newService);
    res.status(201).json({ _id: result.insertedId, ...newService });
  } catch (err) {
    console.error("Failed to create service:", err);
    res.status(500).json({ message: "Failed to create service" });
  }
});

// CHANGED: added requireAuth, requireAdmin.
app.patch("/services/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }

    const {
      serviceName,
      category,
      description,
      price,
      duration,
      image,
      status,
    } = req.body;
    const updateData = {};

    if (serviceName !== undefined) {
      if (!serviceName.trim())
        return res
          .status(400)
          .json({ message: "Service name cannot be empty" });
      updateData.serviceName = serviceName.trim();
    }

    if (category !== undefined) {
      if (!category.trim())
        return res.status(400).json({ message: "Category cannot be empty" });
      updateData.category = category.trim();
    }

    if (description !== undefined) {
      if (!description.trim())
        return res.status(400).json({ message: "Description cannot be empty" });
      updateData.description = description.trim();
    }

    if (image !== undefined) {
      if (!image.trim())
        return res.status(400).json({ message: "Image URL cannot be empty" });
      updateData.image = image.trim();
    }

    if (price !== undefined) {
      if (!(Number(price) > 0))
        return res
          .status(400)
          .json({ message: "Price must be a positive number" });
      updateData.price = Number(price);
    }

    if (duration !== undefined) {
      if (!(Number(duration) > 0))
        return res
          .status(400)
          .json({ message: "Duration must be a positive number" });
      updateData.duration = Number(duration);
    }

    if (status !== undefined) {
      if (!["active", "inactive"].includes(status)) {
        return res
          .status(400)
          .json({ message: "Status must be active or inactive" });
      }
      updateData.status = status;
    }

    if (Object.keys(updateData).length === 0) {
      return res
        .status(400)
        .json({ message: "No valid fields provided for update" });
    }

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updateData, updatedAt: new Date() } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Service not found" });
    }

    const updatedService = await services.findOne({ _id: new ObjectId(id) });
    res.json(updatedService);
  } catch (err) {
    console.error("Failed to update service:", err);
    res.status(500).json({ message: "Failed to update service" });
  }
});

// CHANGED: added requireAuth, requireAdmin.
app.delete("/services/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID" });
    }

    const result = await services.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Service not found" });
    }

    res.json({ message: "Service deleted successfully" });
  } catch (err) {
    console.error("Failed to delete service:", err);
    res.status(500).json({ message: "Failed to delete service" });
  }
});

/* ======================================================
   APPOINTMENT ROUTES (CUSTOMER)
====================================================== */

// CHANGED: added requireAuth. customerId now comes from the verified token
// (req.user.id), not from the query string - otherwise anyone could pass
// ?customerId=<someone else's id> and read their appointments. Assignment
// rule: "Customers can only view their own appointments."
app.get("/appointments", requireAuth, async (req, res) => {
  try {
    const customerId = req.user.id;

    const myAppointments = await appointments
      .find({ customerId: customerId })
      .sort({ createdAt: -1 })
      .toArray();

    const result = [];

    for (const appointment of myAppointments) {
      const service = await services.findOne({
        _id: new ObjectId(appointment.serviceId),
      });

      result.push({
        _id: appointment._id,
        appointmentDate: appointment.appointmentDate,
        timeSlot: appointment.timeSlot,
        message: appointment.message,
        servicePrice: appointment.servicePrice,
        status: appointment.status,
        paymentStatus: appointment.paymentStatus,
        createdAt: appointment.createdAt,
        serviceName: service ? service.serviceName : "Service removed",
        serviceImage: service ? service.image : "",
        serviceCategory: service ? service.category : "",
      });
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch appointments:", err);
    res.status(500).json({ message: "Failed to fetch appointments" });
  }
});

// CHANGED: added requireAuth. customerId is now taken from the verified
// token (req.user.id), not trusted from the request body - otherwise
// anyone could submit an appointment "as" another customer. Assignment
// rule: "Only authenticated Customers can submit appointment requests."
// Also blocks admins from booking, per "Admins cannot submit customer
// appointment requests."
app.post("/appointments", requireAuth, async (req, res) => {
  try {
    const { serviceId, appointmentDate, timeSlot, message } = req.body;
    const customerId = req.user.id;

    if (req.user.role === "admin") {
      return res
        .status(403)
        .json({ message: "Admins cannot submit appointment requests" });
    }

    // Basic required-field validation
    if (!serviceId || !appointmentDate || !timeSlot) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Service must exist and be active
    const service = await services.findOne({ _id: new ObjectId(serviceId) });
    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }
    if (service.status === "inactive") {
      return res
        .status(400)
        .json({ message: "This service is not available for booking" });
    }

    // Appointment date cannot be in the past
    const selectedDate = new Date(appointmentDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate < today) {
      return res
        .status(400)
        .json({ message: "Appointment date cannot be in the past" });
    }

    // Prevent duplicate active appointment for the same date + time slot.
    // Matched by day range (start of day to end of day) instead of an exact
    // Date match, since two Date values for "the same day" can differ by
    // milliseconds and would otherwise never be treated as duplicates.
    const startOfDay = new Date(selectedDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(selectedDate);
    endOfDay.setHours(23, 59, 59, 999);

    const duplicate = await appointments.findOne({
      serviceId,
      appointmentDate: { $gte: startOfDay, $lte: endOfDay },
      timeSlot,
      status: { $in: ["pending", "confirmed"] },
    });
    if (duplicate) {
      return res
        .status(409)
        .json({ message: "This time slot is already booked" });
    }

    const newAppointment = {
      serviceId,
      customerId,
      appointmentDate: selectedDate,
      timeSlot,
      message: message || "",
      servicePrice: service.price,
      status: "pending", // Not trusted from frontend
      paymentStatus: "unpaid", // Not trusted from frontend
      createdAt: new Date(),
    };

    const result = await appointments.insertOne(newAppointment);
    res.status(201).json({ _id: result.insertedId, ...newAppointment });
  } catch (err) {
    console.error("Failed to create appointment:", err);
    res.status(500).json({ message: "Failed to create appointment" });
  }
});

// CHANGED: added requireAuth + ownership check. Assignment rule: "A customer
// can cancel only their own pending appointment requests." Previously anyone
// who knew the appointment ID could cancel it.
app.patch("/appointments/:id/cancel", requireAuth, async (req, res) => {
  try {
    const appointmentId = req.params.id;

    const appointment = await appointments.findOne({
      _id: new ObjectId(appointmentId),
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (appointment.customerId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "You can only cancel your own appointments" });
    }

    if (appointment.status !== "pending") {
      return res
        .status(400)
        .json({ message: "Only pending appointments can be cancelled" });
    }

    await appointments.updateOne(
      { _id: new ObjectId(appointmentId) },
      { $set: { status: "cancelled" } },
    );

    res.json({ message: "Appointment cancelled successfully" });
  } catch (err) {
    console.error("Failed to cancel appointment:", err);
    res.status(500).json({ message: "Failed to cancel appointment" });
  }
});

/* ======================================================
   APPOINTMENT ROUTES (ADMIN)
====================================================== */

// CHANGED: added requireAuth, requireAdmin.
app.get("/admin/appointments", requireAuth, requireAdmin, async (req, res) => {
  try {
    const allAppointments = await appointments
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const result = [];

    for (const appointment of allAppointments) {
      const service = await services.findOne({
        _id: new ObjectId(appointment.serviceId),
      });

      const customer = await users.findOne({
        _id: new ObjectId(appointment.customerId),
      });

      result.push({
        _id: appointment._id,
        appointmentDate: appointment.appointmentDate,
        timeSlot: appointment.timeSlot,
        message: appointment.message,
        servicePrice: appointment.servicePrice,
        status: appointment.status,
        paymentStatus: appointment.paymentStatus,
        createdAt: appointment.createdAt,
        serviceName: service ? service.serviceName : "Service removed",
        customerName: customer ? customer.name : "Unknown customer",
        customerEmail: customer ? customer.email : "",
      });
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch appointments:", err);
    res.status(500).json({ message: "Failed to fetch appointments" });
  }
});

// CHANGED: added requireAuth, requireAdmin.
app.patch(
  "/appointments/:id/status",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const appointmentId = req.params.id;
      const { status } = req.body;

      if (status !== "confirmed" && status !== "cancelled") {
        return res.status(400).json({ message: "Invalid status value" });
      }

      const appointment = await appointments.findOne({
        _id: new ObjectId(appointmentId),
      });

      if (!appointment) {
        return res.status(404).json({ message: "Appointment not found" });
      }

      if (status === "confirmed" && appointment.status !== "pending") {
        return res
          .status(400)
          .json({ message: "Only pending appointments can be confirmed" });
      }

      if (status === "cancelled" && appointment.status === "cancelled") {
        return res
          .status(400)
          .json({ message: "Appointment is already cancelled" });
      }

      await appointments.updateOne(
        { _id: new ObjectId(appointmentId) },
        { $set: { status: status } },
      );

      res.json({ message: `Appointment ${status} successfully` });
    } catch (err) {
      console.error("Failed to update appointment status:", err);
      res.status(500).json({ message: "Failed to update appointment status" });
    }
  },
);

/* ======================================================
   PAYMENT ROUTES (STRIPE)
====================================================== */

// CHANGED: added requireAuth + ownership check. Previously anyone who knew
// an appointment ID could create a checkout session for it, paying (or
// forcing payment of) someone else's appointment.
app.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const { appointmentId } = req.body;

    if (!appointmentId || !ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: "Invalid appointment ID" });
    }

    const appointment = await appointments.findOne({
      _id: new ObjectId(appointmentId),
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (appointment.customerId !== req.user.id) {
      return res
        .status(403)
        .json({ message: "You can only pay for your own appointments" });
    }

    if (appointment.status !== "confirmed") {
      return res
        .status(400)
        .json({ message: "Only confirmed appointments can be paid" });
    }
    if (appointment.paymentStatus === "paid") {
      return res
        .status(400)
        .json({ message: "This appointment is already paid" });
    }

    const service = await services.findOne({
      _id: new ObjectId(appointment.serviceId),
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: service ? service.serviceName : "Salon Service",
            },
            unit_amount: Math.round(appointment.servicePrice * 100), // dollar -> cents
          },
          quantity: 1,
        },
      ],
      metadata: {
        appointmentId: appointment._id.toString(),
        customerId: appointment.customerId,
      },
      success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment-cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Failed to create checkout session:", err);
    res.status(500).json({ message: "Failed to create checkout session" });
  }
});

/* ======================================================
   TRANSACTION ROUTES (ADMIN - READ ONLY)
====================================================== */

// CHANGED: added requireAuth, requireAdmin.
app.get("/admin/transactions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const allTransactions = await transactions
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const result = [];

    for (const transaction of allTransactions) {
      let appointment = null;
      let customer = null;
      let service = null;

      try {
        appointment = await appointments.findOne({
          _id: new ObjectId(String(transaction.appointmentId)),
        });
      } catch {
        appointment = null;
      }

      try {
        customer = await users.findOne(
          { _id: new ObjectId(String(transaction.customerId)) },
          { projection: { name: 1, email: 1 } },
        );
      } catch {
        customer = null;
      }

      if (appointment?.serviceId) {
        try {
          service = await services.findOne(
            { _id: new ObjectId(String(appointment.serviceId)) },
            { projection: { serviceName: 1 } },
          );
        } catch {
          service = null;
        }
      }

      result.push({
        _id: transaction._id,
        stripeSessionId: transaction.stripeSessionId,
        amount: transaction.amount,
        currency: transaction.currency,
        status: transaction.status,
        createdAt: transaction.createdAt,
        appointmentDate: appointment?.appointmentDate ?? null,
        timeSlot: appointment?.timeSlot ?? null,
        customerName: customer?.name ?? "Unknown customer",
        customerEmail: customer?.email ?? "",
        serviceName: service?.serviceName ?? "Service removed",
      });
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch transactions:", err);
    res.status(500).json({ message: "Failed to fetch transactions" });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

export default app;
