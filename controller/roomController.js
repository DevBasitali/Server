const Room = require("../model/room");
const Reservation = require("../model/reservationmodel");
const Guest = require("../model/guest");
const fs = require('fs');
const path = require('path');
const util = require('util');
const unlinkAsync = util.promisify(fs.unlink);
const { uploadImageToS3, deleteImageFromS3 } = require("../service/imageUploadService");


exports.createRoom = async (req, res) => {
  try {
    const { roomNumber, bedType, category, view, rate, owner, status, amenities, publicDescription, adults } =
      req.body;

    const isPubliclyVisible = req.body.isPubliclyVisible === 'true';


    if (await Room.findOne({ roomNumber })) {
      return res.status(400).json({ message: "Room number already exists" });
    }

    const roomData = { roomNumber, bedType, category, view, rate, owner, amenities, isPubliclyVisible, publicDescription, adults };
    if (status) roomData.status = status;

    if (req.files && req.files.length > 0) {
      // Create an array of upload promises
      const uploadPromises = req.files.map(file => uploadImageToS3(file));
      // Wait for all uploads to complete
      const imageUrls = await Promise.all(uploadPromises);
      roomData.images = imageUrls; // Assign the array of S3 URLs
    }

    // if (req.files && req.files.length > 0) {
    //   roomData.images = req.files.map((file) => ({
    //     filename: file.filename,
    //     path: `/uploads/rooms/${file.filename}`,
    //     mimetype: file.mimetype,
    //     size: file.size,
    //   }));
    // }

    const room = await Room.create(roomData);
    res.status(201).json({ message: "Room created successfully", room });
  } catch (err) {
    console.error("Error creating room:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getRooms = async (req, res) => {
  try {
    
    const rooms = await Room.find().sort({ roomNumber: 1 });
    res.status(200).json({ rooms });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getAvailablePresidentialRooms = async (req, res, next) => {
  try {
    // Find all rooms that are:
    // 1. Presidential category
    // 2. Currently available (not booked, occupied, or under maintenance)
    const availablePresidentialRooms = await Room.find({
      category: "Presidential",
      status: "available",
    })
      .select("roomNumber rate bedType view") // Select only the fields we need
      .sort({ roomNumber: "asc" }); // Sort by room number

    if (
      !availablePresidentialRooms ||
      availablePresidentialRooms.length === 0
    ) {
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        message: "No Presidential rooms are currently available",
      });
    }

    // Format the response to be more user-friendly
    const formattedRooms = availablePresidentialRooms.map((room) => ({
      roomNumber: room.roomNumber,
      price: room.rate,
      priceFormatted: `Rs ${room.rate.toLocaleString()}`,
      bedType: room.bedType,
      view: room.view,
      roomId: room._id,
    }));

    res.status(200).json({
      success: true,
      category: "Presidential",
      count: formattedRooms.length,
      data: formattedRooms,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

exports.getRoomById = async (req, res) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }
    res.status(200).json({ room });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.updateRoom = async (req, res) => {
  try {
    const { roomNumber, bedType, category, view, rate, owner, status, deletedImages, amenities, publicDescription, adults } = req.body;
    const isPubliclyVisible = req.body.isPubliclyVisible === 'true';

    const room = await Room.findById(req.params.id);
    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    const updateData = { roomNumber, bedType, category, view, rate, owner, amenities, isPubliclyVisible, publicDescription, adults };
    if (status !== undefined) updateData.status = status;

    let currentImages = room.images || [];

    // --- S3 DELETE LOGIC ---
    if (deletedImages) {
      // Frontend should send a JSON string array of full image URLs to delete
      const imagesToDelete = JSON.parse(deletedImages);
      if (Array.isArray(imagesToDelete) && imagesToDelete.length > 0) {
        // Create an array of deletion promises
        const deletePromises = imagesToDelete.map(url => deleteImageFromS3(url));
        await Promise.all(deletePromises);
        // Filter out the deleted images from our current list
        currentImages = currentImages.filter(imgUrl => !imagesToDelete.includes(imgUrl));
      }
    }
    // --- END S3 DELETE LOGIC ---

    // --- S3 ADD NEW IMAGES LOGIC ---
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(file => uploadImageToS3(file));
      const newImageUrls = await Promise.all(uploadPromises);
      currentImages.push(...newImageUrls);
    }
    // --- END S3 ADD LOGIC ---

    updateData.images = currentImages;

    const updated = await Room.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
      omitUndefined: true,
    });

    res.status(200).json({ message: "Room updated successfully", room: updated });
  } catch (err) {
    console.error("Room update error:", err);
    // No local files to clean up
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    const room = await Room.findById(req.params.id);
    if (!room) {
      return res.status(404).json({ message: "Room not found" });
    }

    // Delete all images from filesystem
    if (room.images && room.images.length > 0) {
      for (const image of room.images) {
        try {
          const filePath = path.join(__dirname, '../uploads/rooms', image.filename);
          // Check if file exists before deleting
          if (fs.existsSync(filePath)) {
            await unlinkAsync(filePath);
            console.log(`Successfully deleted file: ${image.filename}`);
          } else {
            console.log(`File not found, skipping: ${image.filename}`);
          }
        } catch (fileErr) {
          console.error(`Error deleting file ${image.filename}:`, fileErr);
          // Continue with deletion even if one file fails
        }
      }
    }

    // Now delete the room from database
    await room.deleteOne();
    res.status(200).json({ message: "Room deleted successfully" });
  } catch (err) {
    console.error("Room deletion error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getAvailableRooms = async (req, res) => {
  try {
    const { checkin, checkout } = req.query;
    if (!checkin || !checkout) {
      return res.status(400).json({ success: false, message: "Check-in and checkout dates are required." });
    }

    // Use the reliable, native JavaScript UTC date parsing
    const startDate = new Date(`${checkin}T00:00:00.000Z`);
    const endDate = new Date(`${checkout}T00:00:00.000Z`);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid date format. Please use YYYY-MM-DD." });
    }

    if (endDate <= startDate) {
      return res.status(400).json({ success: false, message: "Check-out date must be after check-in date." });
    }

    // The rest of the logic is already robust and correct
    const reservedRooms = await Reservation.find({
      status: { $in: ["reserved", "confirmed"] },
      startAt: { $lt: endDate },
      endAt: { $gt: startDate },
    }).select('room');
    
    const occupiedRooms = await Guest.find({
      status: 'checked-in',
      checkInAt: { $lt: endDate },
      checkOutAt: { $gt: startDate },
    }).select('room');
    
    const unavailableRoomIds = [
      ...reservedRooms.map(r => r.room.toString()),
      ...occupiedRooms.map(g => g.room.toString())
    ];
    const uniqueUnavailableRoomIds = [...new Set(unavailableRoomIds)];

    const availableRooms = await Room.find({
      _id: { $nin: uniqueUnavailableRoomIds },
      status: { $ne: 'maintenance' }
    }).sort({ roomNumber: 1 });

    return res.status(200).json({ success: true, rooms: availableRooms });

  } catch (err) {
    console.error("getAvailableRooms Error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getRoomTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the start of today in UTC for a reliable starting point
    const startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0);

    // Calculate the end date 30 days from now
    const endDate = new Date(startDate);
    endDate.setUTCDate(startDate.getUTCDate() + 30);

    // The rest of the logic is already robust and correct
    const guests = await Guest.find({
      room: id,
      checkInAt: { $lt: endDate },
      checkOutAt: { $gt: startDate },
    }).select('fullName checkInAt checkOutAt status');

    const reservations = await Reservation.find({
      room: id,
      status: { $in: ['reserved', 'confirmed'] },
      startAt: { $lt: endDate },
      endAt: { $gt: startDate },
    }).select('fullName startAt endAt status');

    const bookings = [
      ...guests.map(g => ({
        type: 'Guest (Checked-in)',
        name: g.fullName,
        startDate: g.checkInAt,
        endDate: g.checkOutAt,
        status: g.status,
      })),
      ...reservations.map(r => ({
        type: 'Reservation',
        name: r.fullName,
        startDate: r.startAt,
        endDate: r.endAt,
        status: r.status,
      })),
    ];

    bookings.sort((a, b) => a.startDate - b.startDate);

    res.status(200).json({ success: true, timeline: bookings });

  } catch (err)
 {
    console.error("getRoomTimeline Error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

exports.getAvailableRoomsByCategory = async (req, res) => {
  try {
    const { checkin, checkout, category } = req.query;

    // Validate that all required parameters are present
    if (!checkin || !checkout || !category) {
      return res.status(400).json({
        success: false,
        message: "Check-in date, check-out date, and a category are required.",
      });
    }

    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);

    // --- Find all rooms that are UNAVAILABLE during the requested dates ---
    const conflictingReservations = await Reservation.find({
      room: { $exists: true },
      status: { $nin: ["Cancelled", "No Show", "Checked-out"] },
      checkInDate: { $lt: checkoutDate },
      checkOutDate: { $gt: checkinDate },
    }).select("room");

    const conflictingGuests = await Guest.find({
      room: { $exists: true },
      status: "Checked-in",
      checkInDate: { $lt: checkoutDate },
    }).select("room");

    const reservedRoomIds = conflictingReservations.map(res => res.room);
    const occupiedRoomIds = conflictingGuests.map(guest => guest.room);
    const unavailableRoomIds = [...new Set([...reservedRoomIds, ...occupiedRoomIds])];

    // --- Find rooms that match the category AND are NOT in the unavailable list ---
    const availableRooms = await Room.find({
      _id: { $nin: unavailableRoomIds },
      category: category,
    }).sort({ roomNumber: "asc" });

    res.status(200).json({
      success: true,
      count: availableRooms.length,
      rooms: availableRooms,
    });

  } catch (error) {
    console.error("Error fetching available rooms by category:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching rooms.",
    });
  }
};

