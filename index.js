import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = 5000;

app.use(express.json());
app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}));

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("salonbook")
const users = db.collection("user")
const services = db.collection("services")
const appointments = db.collection("appointments")


app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/users', async (req, res) => {
  const allUsers = await users.find().toArray();
  res.json(allUsers)

})

app.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID"
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
          isBlocked: 1
        }
      }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Profile retrieved successfully",
      data: user
    });

  } catch (err) {
    console.error("Failed to fetch user profile:", err);

    res.status(500).json({
      success: false,
      message: "Failed to fetch profile"
    });
  }
});

app.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, image, phone } = req.body;

    // Validate user ID
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user ID"
      });
    }

    // Check if user exists
    const user = await users.findOne({
      _id: new ObjectId(id)
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Prepare update data
    const updateData = {};

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Name cannot be empty"
        });
      }

      updateData.name = name.trim();
    }

    if (image !== undefined) {
      if (typeof image !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid image URL"
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
          message: "Invalid phone number"
        });
      }

      updateData.phone = phone.trim();
    }

    // Check if there is anything to update
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update"
      });
    }

    // Update user
    await users.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          ...updateData,
          updatedAt: new Date()
        }
      }
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
          isBlocked: 1
        }
      }
    );

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedUser
    });

  } catch (err) {
    console.error("Failed to update user profile:", err);

    res.status(500).json({
      success: false,
      message: "Failed to update profile"
    });
  }
});

app.get('/services', async (req, res) => {
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

    const allServices = await services
      .find(filter)
      .sort(sortOption)
      .toArray();

    res.json(allServices);
  } catch (err) {
    console.error("Failed to fetch services:", err);
    res.status(500).json({ message: "Failed to fetch services" });
  }
});

app.get('/services/:id', async (req, res) => {
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

app.get('/appointments', async (req, res) => {
  try {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ message: "customerId is required" });
    }

    const myAppointments = await appointments
      .find({ customerId: customerId })
      .sort({ createdAt: -1 })
      .toArray();

    const result = [];

    for (const appointment of myAppointments) {
      const service = await services.findOne({
        _id: new ObjectId(appointment.serviceId)
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

app.patch('/appointments/:id/cancel', async (req, res) => {
  try {
    const appointmentId = req.params.id;

    const appointment = await appointments.findOne({
      _id: new ObjectId(appointmentId)
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (appointment.status !== "pending") {
      return res.status(400).json({ message: "Only pending appointments can be cancelled" });
    }

    await appointments.updateOne(
      { _id: new ObjectId(appointmentId) },
      { $set: { status: "cancelled" } }
    );

    res.json({ message: "Appointment cancelled successfully" });

  } catch (err) {
    console.error("Failed to cancel appointment:", err);
    res.status(500).json({ message: "Failed to cancel appointment" });
  }
});


app.post('/appointments', async (req, res) => {
  try {
    const { serviceId, customerId, appointmentDate, timeSlot, message } = req.body;

    // Basic required-field validation
    if (!serviceId || !customerId || !appointmentDate || !timeSlot) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Service must exist and be active
    const service = await services.findOne({ _id: new ObjectId(serviceId) });
    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }
    if (service.status === "inactive") {
      return res.status(400).json({ message: "This service is not available for booking" });
    }

    // Appointment date cannot be in the past
    const selectedDate = new Date(appointmentDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate < today) {
      return res.status(400).json({ message: "Appointment date cannot be in the past" });
    }

    // Prevent duplicate active appointment for same date + time slot
    const duplicate = await appointments.findOne({
      serviceId,
      appointmentDate: selectedDate,
      timeSlot,
      status: { $in: ["pending", "confirmed"] },
    });
    if (duplicate) {
      return res.status(409).json({ message: "This time slot is already booked" });
    }

    const newAppointment = {
      serviceId,
      customerId,
      appointmentDate: selectedDate,
      timeSlot,
      message: message || "",
      servicePrice: service.price,
      status: "pending",       // Not trusted from frontend
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


// ADMIN ROUTES
app.get('/admin/services', async (req, res) => {
  try {
    const allServices = await services.find().sort({ createdAt: -1 }).toArray();
    res.json(allServices);
  } catch (err) {
    console.error("Failed to fetch admin services:", err);
    res.status(500).json({ message: "Failed to fetch services" });
  }
});

// POST SERVICES
app.post('/services', async (req, res) => {
  try {
    const { serviceName, category, description, price, duration, image, status } = req.body;

    if (!serviceName?.trim() || !category?.trim() || !description?.trim() || !image?.trim()) {
      return res.status(400).json({ message: "Name, category, description and image are required" });
    }

    if (!(Number(price) > 0)) {
      return res.status(400).json({ message: "Price must be a positive number" });
    }

    if (!(Number(duration) > 0)) {
      return res.status(400).json({ message: "Duration must be a positive number" });
    }

    if (status !== undefined && !["active", "inactive"].includes(status)) {
      return res.status(400).json({ message: "Status must be active or inactive" });
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

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});